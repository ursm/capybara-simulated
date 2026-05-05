require 'json'
require 'nokogiri'
require 'rack/mime'
require 'rack/mock'
require 'securerandom'
require 'set'
require 'uri'
require 'uri/mailto'
require_relative 'handle_table'
require_relative 'js_runtime'

module Capybara
  module Simulated
    module V2
      # Raised when a Nokogiri node held by a Node has been removed from
      # the document (e.g. via `el.replaceWith(...)` from JS). Driver
      # exposes this as an `invalid_element_error`, so Capybara's
      # synchronize wrapper catches it and reloads the cached element.
      class StaleElement < Capybara::ElementNotFound; end

      DEFAULT_HOST    = 'http://www.example.com'
      BLANK_DOCUMENT  = '<!doctype html><html><body></body></html>'

      Request = Data.define(:method, :url, :body, :content_type)

      # Owns the Nokogiri document, the in-process Rack client, and the
      # lazy QuickJS runtime. Capybara DSL queries hit Nokogiri directly;
      # user JS (when present) sees a thin DOM proxy backed by `dom_op`.
      class Browser
        attr_reader :app, :current_url, :status_code, :response_headers
        attr_accessor :mutation_recording, :timers_active

        def initialize(app)
          @app                = app
          @document           = Nokogiri::HTML5(BLANK_DOCUMENT)
          @handles            = HandleTable.new(@document)
          @js                 = nil
          @current_url        = nil
          @status_code        = nil
          @response_headers   = {}
          @last_request       = nil
          @cookies            = {}
          @file_picks         = {}   # handle -> [path, ...] for <input type="file">
          @modal_handler      = nil  # Proc(type, message, default) → response
          @resource_cache     = {}   # URL -> response body for <script src=...> etc.
          @focused_handle     = nil  # currently-focused element handle
          @mutations          = []
          @mutation_recording = false
          @timers_active      = false
          # Event types with at least one live listener — JS notifies us
          # via __setListenedType so dispatch_event can skip the JS hop
          # for events nobody cares about.
          @listened_types     = Set.new
        end

        def set_listened_type(type, active)
          if active
            @listened_types << type.to_s
          else
            @listened_types.delete(type.to_s)
          end
        end

        def js
          @js ||= JsRuntime.new(self)
        end

        def visit(url)
          navigate(:get, resolve_against_current(url))
        end

        def refresh
          return unless @last_request
          replay(@last_request)
        end

        def reset!
          @document         = Nokogiri::HTML5(BLANK_DOCUMENT)
          @handles.reset!(@document)
          @current_url      = nil
          @status_code      = nil
          @response_headers = {}
          @last_request     = nil
          @cookies.clear
          @file_picks.clear
          @resource_cache.clear
          @focused_handle = nil
          @js&.reset_page
          reset_per_page_state
        end

        def reset_per_page_state
          @mutations.clear
          @mutation_recording = false
          @timers_active      = false
          @listened_types.clear
        end

        def find_xpath(xpath, context = nil)
          root = lookup_node(context) || @document
          root.xpath(xpath).filter_map { |n| @handles.track(n) }
        end

        def find_css(css, context = nil)
          root = lookup_node(context) || @document
          root.css(css).filter_map { |n| @handles.track(n) }
        end

        def all_text(handle)
          (lookup_node(handle)&.text || '').to_s
        end

        # Tags whose contents are not part of the rendered document — used by
        # both `visible?` (the element itself reports invisible) and
        # `collect_visible_text` (subtree contributes no text).
        INVISIBLE_TAGS = %w[head script style template noscript title].to_set.freeze

        # Block-level tags that produce a line break at boundaries (browser
        # `innerText` semantics). Inline whitespace in text nodes is collapsed
        # to a single space; explicit `\n`s here survive normalize_visible_spacing
        # so multi-block content lays out as separate lines.
        BLOCK_TAGS = %w[
          address article aside blockquote body div dl dd dt fieldset
          figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main
          nav ol p pre section table thead tbody tfoot tr td th ul video
        ].to_set.freeze

        INLINE_WHITESPACE_RE = /[\s&&[^ ]]+/

        # Concatenate text from this node's subtree, skipping invisible
        # subtrees and inserting `\n` at block-tag boundaries. Whitespace
        # normalization is the caller's job (V2::Node mixes in
        # Capybara::Node::WhitespaceNormalizer).
        def visible_text(handle)
          node = lookup_node(handle)
          return '' if node.nil?
          out = String.new
          collect_visible_text(node, out, root: true)
          out
        end

        def tag_name(handle)
          (lookup_node(handle)&.name || '').downcase
        end

        def attr(handle, name)
          node = lookup_node(handle)
          return nil if node.nil?
          # validationMessage is a DOM property, not an HTML attribute —
          # Capybara's `validation_message:` field filter reads it via `[]`.
          return validation_message(node) if name == 'validationMessage'
          node[name]
        end

        def value(handle)
          node = lookup_node(handle)
          return nil if node.nil?
          case node.name
          when 'select'
            options = node.css('option')
            selected = options.select { |o| o['selected'] }
            return selected.map { |o| o['value'] || o.text } if node['multiple']
            (selected.first || options.first)&.then { |o| o['value'] || o.text }
          when 'textarea'
            node.text
          else
            node['value']
          end
        end

        def checked?(handle)
          !!lookup_node(handle)&.[]('checked')
        end

        def selected?(handle)
          !!lookup_node(handle)&.[]('selected')
        end

        def set_value(handle, value)
          node = lookup_node(handle)
          return false if node.nil?
          # readonly fields silently reject writes, matching browser behaviour.
          return false if node['readonly']
          case node.name
          when 'input'
            type = (node['type'] || 'text').downcase
            case type
            when 'checkbox', 'radio'
              if value
                node['checked'] = 'checked'
              else
                node.delete('checked')
              end
              # Radio buttons clear other members of the same name group.
              if type == 'radio' && value && (form = enclosing_form(node))
                form.css(%[input[type="radio"][name="#{node['name']}"]]).each do |peer|
                  peer.delete('checked') unless peer == node
                end
              end
            when 'file'
              # File picks live in the Browser-side @file_picks map keyed by
              # handle — keeps them off the live DOM (where they'd leak into
              # innerHTML / be visible to user JS).
              @file_picks[handle] = Array(value).map(&:to_s)
            when 'range', 'number'
              node['value'] = clamp_numeric_input(node, value).to_s
            else
              node['value'] = apply_maxlength(node, value.to_s)
            end
          when 'textarea'
            node.content = value.to_s
          else
            # contenteditable: anything else with `contenteditable` (or
            # whose ancestor has it) accepts text via Node#set the same way
            # a real WYSIWYG would.
            node.content = value.to_s if contenteditable?(node)
          end
          true
        end

        def contenteditable?(node)
          cur = node
          while cur.respond_to?(:[])
            ce = cur['contenteditable']
            return true  if ce && ce != 'false'
            return false if ce == 'false'
            cur = cur.respond_to?(:parent) ? cur.parent : nil
          end
          false
        end

        def file_picks_for(handle)
          @file_picks[handle] || []
        end

        # Mirrors document.activeElement: the focused element, or body
        # when nothing has focus (HTML spec).
        def active_element_handle
          return @focused_handle if @focused_handle
          body = @document.at_css('body')
          body && @handles.track(body)
        end

        FOCUSABLE_TAGS = %w[input textarea select button a].to_set.freeze

        # Programmatic focus accepts anything with a tabindex attribute,
        # including `tabindex="-1"` (which is excluded only from sequential
        # tab order, not from `.focus()`). focus_order applies the stricter
        # check.
        def focusable?(node)
          return false unless node.respond_to?(:[])
          FOCUSABLE_TAGS.include?(node.name) || !node['tabindex'].nil?
        end

        def focus(handle)
          node = lookup_node(handle)
          return unless focusable?(node)
          return if @focused_handle == handle
          if @focused_handle
            blur_handle = @focused_handle
            @focused_handle = nil
            dispatch_event(blur_handle, 'blur', bubbles: false, cancelable: false)
          end
          @focused_handle = handle
          dispatch_event(handle, 'focus', bubbles: false, cancelable: false)
        end

        def blur(handle)
          return unless @focused_handle == handle
          @focused_handle = nil
          dispatch_event(handle, 'blur', bubbles: false, cancelable: false)
        end

        # Session#send_keys: walks the document's focus order on :tab /
        # :shift+:tab; other tokens just forward to the active element.
        # Tab order = document order over inputs / textareas / selects /
        # buttons / links-with-href / [tabindex>=0], skipping disabled
        # / hidden ones.
        def session_send_keys(keys)
          forward = []
          shift = false
          keys.each do |k|
            if k == :shift
              shift = true
            elsif k == :tab
              advance_focus(shift ? -1 : 1)
              shift = false
            else
              forward << k
              shift = false
            end
          end
          if forward.any? && (h = active_element_handle)
            send_keys(h, forward)
          end
        end

        def advance_focus(direction)
          tabbables = focus_order
          return if tabbables.empty?
          if @focused_handle.nil?
            target = direction.positive? ? tabbables.first : tabbables.last
            focus(@handles.track(target))
            return
          end
          current = lookup_node(@focused_handle)
          idx = tabbables.index(current) || -1
          next_idx = (idx + direction) % tabbables.length
          focus(@handles.track(tabbables[next_idx]))
        end

        FOCUSABLE_CSS = 'input:not([type="hidden"]), textarea, select, button, a[href], [tabindex]'.freeze

        def focus_order
          return [] if @document.nil?
          @document.css(FOCUSABLE_CSS).reject do |n|
            n['disabled'] || n['tabindex'].to_s == '-1' || !visible?(@handles.track(n))
          end
        end

        def apply_maxlength(node, str)
          ml = Integer(node['maxlength']) rescue nil
          ml && ml >= 0 ? str[0, ml] : str
        end

        def clamp_numeric_input(node, value)
          n   = Float(value) rescue (return value)
          min = Float(node['min']) rescue nil
          max = Float(node['max']) rescue nil
          n = min if min && n < min
          n = max if max && n > max
          n == n.to_i ? n.to_i : n
        end

        def select_option(handle)
          opt = lookup_node(handle)
          return false unless opt && opt.name == 'option'
          # Browsers don't let users select a disabled option.
          return false if opt['disabled']
          select = opt.ancestors('select').first
          return false unless select
          if select['multiple']
            opt['selected'] = 'selected'
          else
            select.css('option').each { |o| o.delete('selected') }
            opt['selected'] = 'selected'
          end
          true
        end

        def unselect_option(handle)
          opt = lookup_node(handle)
          return false unless opt && opt.name == 'option'
          select = opt.ancestors('select').first
          return false unless select
          # Single-select can't be unselected — surface as the typed
          # exception Capybara expects for `session.unselect` on non-
          # multiple <select>s.
          unless select['multiple']
            raise Capybara::UnselectNotAllowed,
              'Cannot unselect option from single select box.'
          end
          opt.delete('selected')
          true
        end

        # Walks the ancestor chain once, checking style/[hidden]/closed-details
        # in a single pass. visible? is called per matched element on every
        # selector evaluation, so fusing the walk halves ancestor iterations.
        # `summary_seen` tracks whether the starting node sits inside a
        # `<summary>` subtree — a closed-details ancestor only hides us if
        # we don't (HTML spec).
        def visible?(handle)
          node = lookup_node(handle)
          return false if node.nil?
          return false if INVISIBLE_TAGS.include?(node.name)
          return false if node.name == 'input' && (node['type'] || '').downcase == 'hidden'
          summary_seen = node.name == 'summary'
          cur = node
          while cur.respond_to?(:[])
            return true  if cur.is_a?(Nokogiri::XML::Document)
            return false if self_hidden?(cur)
            return false if cur.name == 'details' && !cur['open'] && !summary_seen
            summary_seen = true if cur.name == 'summary'
            cur = cur.respond_to?(:parent) ? cur.parent : nil
          end
          true
        end

        # `<option>` is disabled if any ancestor `<optgroup>`/`<select>` is
        # disabled. Other form controls inherit `disabled` from a wrapping
        # `<fieldset disabled>` *unless* they sit inside its first `<legend>`.
        def disabled?(handle)
          node = lookup_node(handle)
          return false if node.nil? || !node.respond_to?(:[])
          return true  if node['disabled']
          if node.name == 'option'
            cur = node.parent
            while cur.respond_to?(:element?) && cur.element? && %w[optgroup select].include?(cur.name)
              return true if cur['disabled']
              cur = cur.parent
            end
          end
          if FORM_CONTROL_TAGS.include?(node.name)
            cur = node.parent
            while cur.respond_to?(:element?) && cur.element?
              if cur.name == 'fieldset' && cur['disabled']
                legend = cur.element_children.find { |c| c.name == 'legend' }
                return false if legend && (node == legend || node.ancestors.include?(legend))
                return true
              end
              cur = cur.parent
            end
          end
          false
        end

        FORM_CONTROL_TAGS = %w[input select textarea button optgroup option].to_set.freeze

        def html
          @document.to_html
        end

        def title
          @document.at('head > title')&.text || ''
        end

        MODIFIER_KEYS = %i[shift control alt meta command].to_set.freeze

        def click(handle, modifiers = nil)
          node = lookup_node(handle)
          return false if node.nil?
          # Click on a focusable element steals focus first — matches what
          # browsers do (focus event fires before click for synthetic
          # element.click() / user clicks).
          focus(handle) if node.respond_to?(:name) && FOCUSABLE_TAGS.include?(node.name)
          # Fire 'click' before the default action — handlers may
          # preventDefault() to suppress navigation / form submit.
          return true unless dispatch_event(handle, 'click', **modifier_init(modifiers))
          case node.name
          when 'a'
            href = node['href']
            return true if href.nil? || href.empty?
            target = resolve(href)
            # Pure-fragment / same-document anchor — browsers don't navigate.
            return true if same_document_fragment?(target)
            navigate(:get, target)
            true
          when 'button', 'input'
            click_form_control(node)
          when 'label'
            target = label_target(node)
            target ? click(@handles.track(target)) : false
          when 'summary'
            # Clicking <summary> toggles the parent <details>'s open state.
            details = node.parent
            if details.respond_to?(:name) && details.name == 'details'
              if details['open']
                details.delete('open')
              else
                details['open'] = ''
              end
              dispatch_event(@handles.track(details), 'toggle', bubbles: false)
            end
            true
          else
            false
          end
        end

        def submit_form(handle)
          node = lookup_node(handle)
          return false unless node
          form = node.name == 'form' ? node : enclosing_form(node)
          form ? submit(form, nil) : false
        end

        # Fire input + change after a user-driven value change. Mirrors what
        # Selenium / a real browser do for `fill_in` / `set`. JS-driven writes
        # via `setValue` dom_op skip this — that path is the JS author's call.
        def set_value_with_events(handle, value)
          # Focus the field first — fill_in / set on a real browser implies
          # clicking into the field, which fires focus before input/change.
          focus(handle)
          # Trailing \n on a single-input text form submits the form (browser
          # default behaviour for Enter in a single-field form). Strip the \n
          # before storing the value so the submitted body doesn't carry it.
          submit_after = should_submit_on_enter?(lookup_node(handle), value)
          changed = set_value(handle, submit_after ? value.to_s.chomp("\n") : value)
          return changed unless changed && @js
          dispatch_input_change(handle)
          submit_form(handle) if submit_after
          changed
        end

        TEXT_LIKE_INPUT_TYPES = Set['text', 'email', 'password', 'search', 'tel', 'url'].freeze

        def should_submit_on_enter?(node, value)
          return false if node.nil? || !value.is_a?(String) || !value.end_with?("\n")
          return false unless node.name == 'input'
          form = enclosing_form(node) or return false
          # HTML5 implicit submission: form has *exactly one* text-like input.
          # Short-circuit at 2 instead of materialising the whole list.
          count = 0
          form.xpath('.//input').each do |i|
            next unless TEXT_LIKE_INPUT_TYPES.include?((i['type'] || 'text').downcase)
            count += 1
            return false if count > 1
          end
          count == 1
        end

        SPECIAL_KEY_CODES = {
          backspace: 8, tab: 9, enter: 13, return: 13, escape: 27, space: 32,
          left: 37, up: 38, right: 39, down: 40, delete: 46, home: 36, end: 35,
          shift: 16, control: 17, alt: 18, meta: 91
        }.freeze

        # Best-effort send_keys. Handles literal Strings, special tokens
        # (:space, :enter, :backspace, :delete, :left, :right, :home, :end,
        # arrow keys), modifier-style tokens (:shift) that fold subsequent
        # input to upper-case, and array bursts ([:shift, 'o']) that scope
        # the modifier to the burst. Maintains a per-call caret position
        # so :left / :right insert at the right offset.
        def send_keys(handle, keys)
          node = lookup_node(handle)
          return false if node.nil?
          start  = (node.name == 'textarea' ? node.text : node['value']).to_s
          state  = {value: start.dup, caret: start.length, shift: false}
          keys.each { |k| apply_send_key(handle, state, k) }
          set_value(handle, state[:value])
          dispatch_input_change(handle)
          true
        end

        def apply_send_key(handle, state, key)
          case key
          when Array
            saved = state[:shift]
            key.each { |sub| apply_send_key(handle, state, sub) }
            state[:shift] = saved
          when Symbol
            apply_special_key(handle, state, key)
          when String
            text = state[:shift] ? key.upcase : key
            text.each_char { |c| insert_char(handle, state, c) }
          end
        end

        def apply_special_key(handle, state, key)
          case key
          when :shift, :control, :alt, :meta
            state[:shift] = true if key == :shift
            dispatch_key_event(handle, 'keydown', SPECIAL_KEY_CODES[key])
          when :space
            insert_char(handle, state, ' ')
          when :enter, :return
            dispatch_key_event(handle, 'keydown', SPECIAL_KEY_CODES[key])
            dispatch_key_event(handle, 'keyup',   SPECIAL_KEY_CODES[key])
          when :backspace
            if state[:caret] > 0
              state[:value] = state[:value][0, state[:caret] - 1] + state[:value][state[:caret]..]
              state[:caret] -= 1
            end
            dispatch_key_event(handle, 'keydown', SPECIAL_KEY_CODES[:backspace])
            dispatch_key_event(handle, 'keyup',   SPECIAL_KEY_CODES[:backspace])
          when :delete
            if state[:caret] < state[:value].length
              state[:value] = state[:value][0, state[:caret]] + state[:value][state[:caret] + 1..]
            end
            dispatch_key_event(handle, 'keydown', SPECIAL_KEY_CODES[:delete])
            dispatch_key_event(handle, 'keyup',   SPECIAL_KEY_CODES[:delete])
          when :left  then state[:caret] = [state[:caret] - 1, 0].max
          when :right then state[:caret] = [state[:caret] + 1, state[:value].length].min
          when :home  then state[:caret] = 0
          when :end   then state[:caret] = state[:value].length
          else
            code = SPECIAL_KEY_CODES[key] || 0
            dispatch_key_event(handle, 'keydown', code)
            dispatch_key_event(handle, 'keyup',   code)
          end
        end

        def insert_char(handle, state, char)
          state[:value] = state[:value][0, state[:caret]] + char + state[:value][state[:caret]..]
          state[:caret] += char.length
          code = char.upcase.bytes.first || 0
          dispatch_key_event(handle, 'keydown',  code)
          dispatch_key_event(handle, 'keypress', code)
          dispatch_key_event(handle, 'keyup',    code)
        end

        def dispatch_key_event(handle, type, key_code)
          return unless @js && @listened_types.include?(type)
          js.call('__dispatchKeyFromRuby', handle, type.to_s, key_code)
          settle
        end

        def evaluate_script(code, args = [])
          js.call('__evalScript', code, args.map { |a| marshal_script_arg(a) })
        end

        def marshal_script_arg(arg)
          case arg
          when Capybara::Driver::Node then {'__elementHandle' => arg.native}
          when Array                  then arg.map { |x| marshal_script_arg(x) }
          when Hash                   then arg.transform_values { |v| marshal_script_arg(v) }
          else arg
          end
        end

        # The "user typed into a field" event pair. Both bubble, neither is
        # cancelable — matches what real browsers fire after a value change
        # via keyboard or driver `set` / `send_keys`.
        def dispatch_input_change(handle)
          dispatch_event(handle, 'input',  bubbles: true, cancelable: false)
          dispatch_event(handle, 'change', bubbles: true, cancelable: false)
        end

        # Fire a JS event at `handle`. Returns true unless a listener called
        # `preventDefault()`. Short-circuits when JS isn't booted, when no
        # listener is registered for this event type, *and* no observer is
        # watching for the side-effects — the cheap path covers the bulk of
        # plain rack_test-style flows where most events are nobody's problem.
        # Extra init keys (shiftKey / ctrlKey / etc.) flow through to the
        # JS-side Event constructor.
        def dispatch_event(handle, type, bubbles: true, cancelable: true, **init_extras)
          return true unless @js && handle
          return true unless @listened_types.include?(type) || @mutation_recording
          result = js.call('__dispatchFromRuby', handle, type.to_s,
                           {bubbles: bubbles, cancelable: cancelable, **init_extras})
          settle
          result
        end

        # Build the MouseEvent init slice from Capybara modifier symbols.
        # `:command` is the macOS alias for `:meta` per Capybara's docs.
        def modifier_init(modifiers)
          return {} if modifiers.nil? || modifiers.empty?
          flags = Array(modifiers).select { |m| MODIFIER_KEYS.include?(m) }
          {
            shiftKey: flags.include?(:shift),
            ctrlKey:  flags.include?(:control),
            altKey:   flags.include?(:alt),
            metaKey:  flags.include?(:meta) || flags.include?(:command)
          }
        end

        # Push a buffered MutationRecord. No-op when no observer is active —
        # the JS side flips @mutation_recording via the __notifyMutationActive
        # callback so dom_op writes pay nothing on observer-less pages.
        def record_mutation(type, target_handle, **extra)
          return unless @mutation_recording && target_handle
          @mutations << {type: type, target: target_handle, **extra}
        end

        # Run timers, deliver mutation records, repeat until quiescent.
        # Each iteration: drain queued timers (which may queue mutations
        # via dom_op), then ship pending mutations to JS observers (whose
        # callbacks may queue more timers). Cap iterations to break loops.
        def settle
          return unless @js
          10.times do
            js.drain_timers if @timers_active
            break if @mutations.empty?
            records, @mutations = @mutations, []
            js.call('__deliverMutations', records)
          end
        end

        # Single dispatch entry called from JS via `__dom(handle, op, args)`.
        def dom_op(handle, op, args)
          node = lookup_node(handle) || @document
          case op
          when 'querySelector'
            @handles.track(node.respond_to?(:at_css) ? node.at_css(args[0]) : nil)
          when 'querySelectorAll'
            (node.respond_to?(:css) ? node.css(args[0]) : []).map { |n| @handles.track(n) }
          when 'getElementById'
            @handles.track(@document.at_xpath('.//*[@id=$id]', nil, id: args[0].to_s))
          when 'closest'
            cur = node
            while cur && cur.element?
              return @handles.track(cur) if cur.matches?(args[0])
              cur = cur.parent
            end
            nil
          when 'matches'
            node.element? && node.matches?(args[0])
          when 'contains'
            other = lookup_node(args[0])
            other && (node == other || other.ancestors.include?(node))
          when 'parentNode', 'parentElement'
            parent = node.respond_to?(:parent) ? node.parent : nil
            parent.respond_to?(:element?) ? @handles.track(parent) : nil
          when 'firstChild'      then @handles.track(node.children.first)
          when 'lastChild'       then @handles.track(node.children.last)
          when 'nextSibling'     then @handles.track(node.next)
          when 'previousSibling' then @handles.track(node.previous)
          when 'children'        then node.element_children.map { |n| @handles.track(n) }
          when 'childNodes'      then node.children.map { |n| @handles.track(n) }
          when 'nodeType'        then node_type_for(node)
          when 'nodeName'        then (node.name || '').upcase
          when 'tagName'         then (node.element? ? node.name.upcase : '')
          when 'textContent'     then node.text
          when 'innerText'       then visible_text(handle)
          when 'innerHTML'       then node.respond_to?(:inner_html) ? node.inner_html : node.to_html
          when 'outerHTML'       then node.to_html
          when 'getAttribute'    then node.respond_to?(:[]) ? node[args[0]] : nil
          when 'hasAttribute'    then node.respond_to?(:[]) ? !node[args[0]].nil? : false
          when 'attributes'
            (node.respond_to?(:attributes) ? node.attributes : {})
              .map { |k, v| [k, v.respond_to?(:value) ? v.value : v.to_s] }
          when 'value'           then value(handle)
          when 'checked'         then checked?(handle)
          when 'disabled'        then !!(node.respond_to?(:[]) && node['disabled'])
          when 'hidden'          then !!(node.respond_to?(:[]) && node['hidden'])
          when 'form'            then @handles.track(enclosing_form(node))
          when 'validity'           then compute_validity(node)
          when 'validationMessage'  then validation_message(node)
          when 'focus' then focus(handle); nil
          when 'blur'  then blur(handle);  nil
          when 'setAttribute'
            if node.element?
              old = node[args[0]]
              node[args[0]] = args[1].to_s
              record_mutation('attributes', handle, attributeName: args[0], oldValue: old)
            end
            nil
          when 'removeAttribute'
            if node.element?
              old = node[args[0]]
              node.delete(args[0])
              record_mutation('attributes', handle, attributeName: args[0], oldValue: old)
            end
            nil
          when 'setValue'        then set_value(handle, args[0]); nil
          when 'setChecked'      then set_value(handle, !!args[0]); nil
          when 'setTextContent'
            node.content = args[0].to_s if node.respond_to?(:content=)
            record_mutation('childList', handle, addedNodes: [], removedNodes: [])
            nil
          when 'setInnerHTML'
            node.inner_html = args[0].to_s if node.respond_to?(:inner_html=)
            record_mutation('childList', handle, addedNodes: [], removedNodes: [])
            nil
          when 'appendChild'
            child = lookup_node(args[0])
            if child && node.respond_to?(:add_child)
              node.add_child(child)
              record_mutation('childList', handle, addedNodes: [args[0]], removedNodes: [])
            end
            args[0]
          when 'removeChild'
            child = lookup_node(args[0])
            if child && child.parent
              parent_handle = @handles.track(child.parent)
              child.unlink
              record_mutation('childList', parent_handle, addedNodes: [], removedNodes: [args[0]])
            end
            args[0]
          when 'insertBefore'
            new_child = lookup_node(args[0])
            ref_child = lookup_node(args[1])
            if new_child
              ref_child ? ref_child.add_previous_sibling(new_child) : node.add_child(new_child)
              record_mutation('childList', handle, addedNodes: [args[0]], removedNodes: [])
            end
            args[0]
          when 'replaceChild'
            new_child = lookup_node(args[0])
            old_child = lookup_node(args[1])
            if new_child && old_child
              old_child.replace(new_child)
              record_mutation('childList', handle, addedNodes: [args[0]], removedNodes: [args[1]])
            end
            args[1]
          when 'createElement'
            @handles.track(@document.create_element(args[0].to_s))
          when 'createTextNode'
            @handles.track(@document.create_text_node(args[0].to_s))
          when 'createComment'
            @handles.track(Nokogiri::XML::Comment.new(@document, args[0].to_s))
          when 'createDocumentFragment'
            @handles.track(Nokogiri::XML::DocumentFragment.new(@document))
          when 'getElementsByTagName'
            tag = args[0].to_s.downcase
            return @document.css('*').map { |n| @handles.track(n) } if tag == '*'
            (node.respond_to?(:css) ? node.css(tag) : []).map { |n| @handles.track(n) }
          when 'getElementsByClassName'
            tokens = args[0].to_s.split
            return [] if tokens.empty? || !node.respond_to?(:css)
            # AND-match every class token (`getElementsByClassName('a b')`
            # = elements with `class` containing both `a` and `b`).
            node.css(tokens.map { |t| ".#{t}" }.join).map { |n| @handles.track(n) }
          when 'getElementsByName'
            @document.xpath('.//*[@name=$n]', nil, n: args[0].to_s).map { |n| @handles.track(n) }
          when 'cloneNode'
            deep = !!args[0]
            cloned = node.dup(deep ? 1 : 0)
            @handles.track(cloned)
          when 'compareDocumentPosition'
            other = lookup_node(args[0])
            compare_positions(node, other)
          else
            warn "[capybara-simulated/v2] unsupported dom op: #{op}" if ENV['CSIM_V2_DEBUG']
            nil
          end
        end


        def lookup_node(handle)
          handle && @handles.lookup(handle)
        end

        # True if the handle's node has been detached from the document
        # (parent chain no longer reaches @document). DOM mutations from
        # JS (replaceWith, removeChild, innerHTML reset) all leave the old
        # node detached but still alive in Ruby — Capybara needs us to
        # signal that so its automatic-reload retry kicks in.
        def stale?(handle)
          node = lookup_node(handle)
          return false if node.nil? || node.is_a?(Nokogiri::XML::Document)
          # Walk parents until we either reach the document (alive) or run
          # out (detached). Document itself doesn't respond_to?(:parent),
          # so checking is_a?(Document) on each step is the termination.
          cur = node
          loop do
            return true  if cur.nil?
            return false if cur.is_a?(Nokogiri::XML::Document)
            cur = cur.respond_to?(:parent) ? cur.parent : nil
          end
        end

        def check_stale(handle)
          raise StaleElement, 'element is no longer attached to the document' if stale?(handle)
        end

        # Wire a one-shot modal handler. The block receives [type, message,
        # default_value] and returns the JS-side response (nil for alert,
        # bool for confirm, String|nil for prompt). Cleared after the
        # `with_modal` body returns regardless of outcome.
        def with_modal(handler)
          prev = @modal_handler
          @modal_handler = handler
          yield
        ensure
          @modal_handler = prev
        end

        # JS history.pushState / replaceState passes the URL here. Resolves
        # against the current page (so SPA-style "/foo" updates the path
        # only) and updates @current_url; no fetch happens — the document
        # stays. nil URL is a no-op (history.pushState({}, '') is valid).
        def history_state(url)
          @current_url = resolve(url.to_s) if url
          nil
        end

        # JS `location.href = ...` / `location.pathname = ...` /
        # `location.assign(...)`. Browsers tear the page down and load
        # the new URL — we navigate, which re-runs scripts and resets
        # the JS-side state.
        def location_assign(url)
          return if url.nil? || url.empty?
          navigate(:get, resolve(url.to_s))
          nil
        end

        def handle_modal(type, message, default_value)
          if @modal_handler
            @modal_handler.call(type, message, default_value)
          else
            # No handler installed — match Capybara's auto-dismiss
            # behaviour for stray dialogs: confirm/prompt → cancel,
            # alert → ignored.
            type == 'prompt' ? nil : false
          end
        end

        private

        def navigate(method, url, body: nil, content_type: nil)
          req = Request.new(method: method, url: url, body: body, content_type: content_type)
          @last_request = req
          replay(req)
        end

        def replay(req)
          uri  = URI.parse(req.url)
          opts = {method: req.method.to_s.upcase}
          opts[:input]         = req.body if req.body
          opts['CONTENT_TYPE'] = req.content_type if req.content_type
          opts['HTTP_COOKIE']  = cookie_header_value unless @cookies.empty?
          opts['HTTP_REFERER'] = @current_url if @current_url
          # Hand env_for the full absolute URL — Rack derives HTTP_HOST /
          # SERVER_NAME / SERVER_PORT / rack.url_scheme from it so server-
          # side request.host etc. reflect the visit URL, not Rack's
          # default example.org:80. Same shape v1 uses.
          env  = Rack::MockRequest.env_for(req.url, **opts)
          status, headers, body_iter = @app.call(env)
          response_body = read_rack_body(body_iter)

          ingest_set_cookie(headers)

          if (300..399).cover?(status) && (loc = (headers['location'] || headers['Location']))
            # Don't bump @current_url here — keep the pre-redirect URL so
            # the recursive replay sends the original page as Referer
            # (matches Capybara's #visit-with-redirect contract).
            # 307/308 preserve the original method + body; 301/302/303 fall
            # back to GET (browser convention).
            # Browsers carry the request's fragment through redirects when
            # the redirect Location doesn't itself have one (RFC 7231 §7.1.2).
            preserve = status == 307 || status == 308
            target   = resolve(loc, base: req.url)
            target   = "#{target}##{uri.fragment}" if uri.fragment && !target.include?('#')
            return replay(Request.new(
              method:       preserve ? req.method : :get,
              url:          target,
              body:         preserve ? req.body : nil,
              content_type: preserve ? req.content_type : nil
            ))
          end

          @status_code      = status
          @response_headers = headers
          @current_url      = req.url
          # Handle integers get reused across documents, so the old file-pick
          # map would silently re-attach to whatever now lives at those ints.
          # Same goes for focus state.
          @file_picks.clear
          @focused_handle = nil
          @document    = Nokogiri::HTML5(response_body)
          @handles.reset!(@document)
          # Run inline `<script>` tags only when the page actually has any —
          # avoids paying QuickJS cold-start on rack_test-style flows. Reset
          # the virtual clock so timers from the previous page can't fire on
          # this one, and drain afterwards to settle initial setTimeout(0)s.
          if @document.at_css('script')
            js.reset_page
            reset_per_page_state
            js.run_scripts(@document) { |src| fetch_resource(resolve(src)) }
            # Fire DOMContentLoaded + load so libraries that queue work
            # behind those events (jQuery's $(fn) ready queue, Stimulus's
            # connectedCallback wiring) actually run.
            fire_lifecycle_events
            settle
          elsif @js
            @js.reset_page
            reset_per_page_state
          end
          status
        end

        # In-page resolution — link href, form action, <script src>. Honours
        # `<base href="...">` per the HTML spec.
        def resolve(url, base: nil)
          return url if url =~ %r{\A[a-z]+://}i
          URI.join(base || base_for_relative_urls || DEFAULT_HOST, url).to_s
        end

        # Top-level navigation (visit). A bare relative path is treated as
        # path-from-root of the current host — Capybara's `#visit` contract
        # is "go here under the test app", not browser `location.href` URI
        # joining (which would carry over the previous page's directory).
        def resolve_against_current(url)
          return url if url =~ %r{\A[a-z]+://}i
          current = URI.parse(@current_url || DEFAULT_HOST)
          rooted  = url.start_with?('/') ? url : "/#{url}"
          URI.join("#{current.scheme}://#{current.host}", rooted).to_s
        end

        def same_document_fragment?(target)
          return true if target.start_with?('#')
          return false if @current_url.nil?
          tgt = URI.parse(target) rescue (return false)
          cur = URI.parse(@current_url) rescue (return false)
          tgt.scheme == cur.scheme && tgt.host == cur.host && tgt.path == cur.path && !tgt.fragment.nil?
        end

        def base_for_relative_urls
          base_href = @document&.at_xpath('.//base/@href')&.value
          return @current_url if base_href.nil? || base_href.empty?
          base_href.match?(%r{\A[a-z]+://}i) ? base_href : URI.join(@current_url || DEFAULT_HOST, base_href).to_s
        end

        # Fetch a static resource through the same Rack app (e.g. an
        # external <script src="...">). Returns the body string, or nil on
        # non-200. Doesn't update navigation state — the document, current
        # URL, and last-request tuple stay put. Cached per-URL across
        # visits and cleared on reset! — test-app static assets (jQuery
        # etc.) don't change between requests, and skipping the Rack
        # round-trip is a meaningful win on JS-heavy pages.
        def fetch_resource(url)
          @resource_cache.fetch(url) { @resource_cache[url] = rack_get(url) }
        end

        def rack_get(url)
          uri  = URI.parse(url)
          opts = {method: 'GET'}
          opts['HTTP_COOKIE'] = cookie_header_value unless @cookies.empty?
          env  = Rack::MockRequest.env_for(uri.request_uri, **opts)
          status, _headers, body_iter = @app.call(env)
          body = read_rack_body(body_iter)
          return body if (200..299).cover?(status)
          warn "[capybara-simulated/v2] script src #{url} returned #{status}" if ENV['CSIM_V2_DEBUG']
          nil
        end

        def read_rack_body(iter)
          body = +''
          iter.each { |c| body << c.to_s } if iter.respond_to?(:each)
          iter.close if iter.respond_to?(:close)
          body
        end

        def fire_lifecycle_events
          return unless @js
          js.call('__syncLocation', @current_url.to_s) if @current_url
          # readyState transitions: loading → interactive (just before
          # DOMContentLoaded) → complete (after window load).
          js.call('__setReadyState', 'interactive')
          js.call('__fireLifecycle', 'DOMContentLoaded')
          js.call('__setReadyState', 'complete')
          js.call('__fireLifecycle', 'load')
        end

        def cookie_header_value
          @cookies.map { |k, v| "#{k}=#{v}" }.join('; ')
        end

        # Parse Set-Cookie response header(s) and stash name=value pairs.
        # We don't honour Path / Domain / Expires — single-session, single-
        # domain cookie jar matches what rack_test does for spec purposes.
        def ingest_set_cookie(headers)
          raw = headers['set-cookie'] || headers['Set-Cookie']
          return if raw.nil? || raw.empty?
          (raw.is_a?(Array) ? raw : raw.split("\n")).each do |line|
            pair, * = line.split(';', 2)
            name, value = pair.to_s.split('=', 2)
            next if name.nil? || name.empty?
            @cookies[name.strip] = value.to_s.strip
          end
        end

        def click_form_control(node)
          type = (node['type'] || (node.name == 'button' ? 'submit' : 'text')).downcase
          case type
          when 'submit', 'image'
            form = enclosing_form(node) or return false
            submit(form, node)
          when 'reset'
            # Stored attributes are the source of truth in v2 — we don't track
            # an in-memory defaultValue snapshot, so reset is a no-op.
            true
          when 'checkbox'
            set_value(@handles.track(node), !node['checked'])
            true
          when 'radio'
            set_value(@handles.track(node), true)
            true
          else
            false
          end
        end

        def submit(form, submitter)
          form_handle = @handles.track(form)
          return true unless dispatch_event(form_handle, 'submit')
          # `formaction` / `formmethod` on the submitter override the form's
          # own action / method (HTML5).
          method_attr = (submitter && submitter['formmethod']) || form['method'] || 'get'
          action_attr = (submitter && submitter['formaction']) || form['action']
          method = method_attr.to_s.downcase
          action = resolve(action_attr.to_s.empty? ? @current_url.to_s : action_attr.to_s)
          if method == 'post' && multipart_form?(form)
            content_type, body = build_multipart(form, submitter)
            navigate(:post, action, body: body, content_type: content_type)
          elsif method == 'post'
            navigate(:post, action,
                     body:         URI.encode_www_form(serialize_form(form, submitter)),
                     content_type: 'application/x-www-form-urlencoded')
          else
            uri = URI.parse(action)
            uri.query = URI.encode_www_form(serialize_form(form, submitter))
            navigate(:get, uri.to_s)
          end
          true
        end

        def multipart_form?(form)
          form['enctype'].to_s.downcase == 'multipart/form-data'
        end

        FORM_FIELD_CSS = 'input, textarea, select, button'.freeze

        # Yields each submittable form-control entry as
        # `[name, type, value, picks]` — `picks` is the array of paths for a
        # file input, otherwise nil. serialize_form / build_multipart consume
        # this single walk so the field-selection rules stay in one place.
        # Walks fields in document order across descendants AND any field
        # outside the form that opts in via `form="<id>"`.
        def each_form_field(form, submitter)
          form_id    = form['id']
          associated = if form_id && !form_id.empty?
            xpath = %w[input textarea select button]
              .flat_map { |t| ["descendant::#{t}", "//#{t}[@form=$fid]"] }
              .join(' | ')
            @document.xpath(xpath, nil, fid: form_id.to_s)
          else
            form.css(FORM_FIELD_CSS)
          end
          associated.each do |field|
            name = field['name']
            next if name.nil? || name.empty? || field['disabled']
            # If a field declares form="other", skip it for this form.
            next if (fa = field['form']) && !fa.empty? && fa != form_id
            type = (field['type'] || (field.name == 'button' ? 'submit' : nil) || field.name).downcase
            case type
            when 'submit', 'image', 'button', 'reset'
              next unless field == submitter
              yield name, type, field['value'].to_s, nil
            when 'checkbox', 'radio'
              yield name, type, (field['value'] || 'on'), nil if field['checked']
            when 'select'
              options  = field.css('option')
              selected = options.select { |o| o['selected'] }
              # No explicit selection on a single-select → the first option
              # is the default (HTML4/5 form-submission spec). multiple-
              # selects with nothing selected submit nothing.
              selected = [options.first].compact if selected.empty? && !field['multiple']
              selected.each { |opt| yield name, type, (opt['value'] || opt.text), nil }
            when 'textarea'
              # HTML form submission normalises LF → CRLF in textarea content.
              yield name, type, field.text.gsub(/\r\n|\r|\n/, "\r\n"), nil
            when 'file'
              yield name, type, nil, file_picks_for(@handles.track(field))
            else
              yield name, type, field['value'].to_s, nil
            end
          end
        end

        def serialize_form(form, submitter)
          out = []
          each_form_field(form, submitter) do |name, type, value, picks|
            if type == 'file'
              # Non-multipart forms submit only the basename of any picked
              # file (browsers can't actually upload through urlencoded).
              out << [name, picks.empty? ? '' : File.basename(picks.first)]
            else
              out << [name, value]
            end
          end
          out
        end

        def build_multipart(form, submitter)
          boundary = "csim-#{SecureRandom.hex(8)}"
          body     = String.new.force_encoding(Encoding::ASCII_8BIT)
          each_form_field(form, submitter) do |name, type, value, picks|
            if type == 'file'
              if picks.empty?
                append_multipart_part(body, boundary, name, '', filename: '')
              else
                picks.each do |path|
                  append_multipart_part(body, boundary, name, File.binread(path),
                                        filename:     File.basename(path),
                                        content_type: Rack::Mime.mime_type(File.extname(path)))
                end
              end
            else
              append_multipart_part(body, boundary, name, value.to_s)
            end
          end
          body << "--#{boundary}--\r\n"
          ["multipart/form-data; boundary=#{boundary}", body]
        end

        def append_multipart_part(body, boundary, name, content, filename: nil, content_type: nil)
          body << "--#{boundary}\r\n"
          disposition = %[form-data; name="#{name}"]
          disposition += %[; filename="#{filename}"] if filename
          body << "Content-Disposition: #{disposition}\r\n"
          body << "Content-Type: #{content_type}\r\n" if content_type
          body << "\r\n"
          body << content.to_s.b
          body << "\r\n"
        end

        def enclosing_form(node)
          if (id = node['form'])
            form = @document.at_xpath('.//form[@id=$id]', nil, id: id.to_s)
            return form if form
          end
          cur = node.respond_to?(:parent) ? node.parent : nil
          cur = cur.parent while cur.respond_to?(:parent) && cur.name != 'form'
          cur if cur.respond_to?(:name) && cur.name == 'form'
        end

        URL_RE = %r{\A[a-z][a-z0-9+\-.]*://}i.freeze

        VALIDITY_KEYS = %w[
          valueMissing typeMismatch patternMismatch tooLong tooShort
          rangeUnderflow rangeOverflow stepMismatch badInput customError
        ].freeze

        ALL_VALID = (VALIDITY_KEYS.zip([false] * VALIDITY_KEYS.size).to_h.merge('valid' => true)).freeze

        # Best-effort HTML5 ValidityState. Real browsers have richer
        # behaviour (locale-aware number parsing, IDN URL handling) but
        # this covers the constraints Capybara's `valid:` filter exercises.
        def compute_validity(node)
          return ALL_VALID unless node.respond_to?(:[])
          type = (node['type'] || 'text').downcase
          # Selects / buttons / static elements aren't constraint-validated.
          if !%w[input textarea].include?(node.name) || %w[hidden button submit reset image].include?(type)
            return ALL_VALID
          end
          value   = (node.name == 'textarea' ? node.text : node['value']).to_s
          pattern = node['pattern']
          ml      = node['maxlength'] && Integer(node['maxlength'], exception: false)
          minl    = node['minlength'] && Integer(node['minlength'], exception: false)
          mn      = node['min']       && Float(node['min'], exception: false)
          mx      = node['max']       && Float(node['max'], exception: false)
          numeric = !value.empty? && type == 'number' ? Float(value, exception: false) : nil
          {
            'valueMissing'    => node['required'] && value.empty?,
            'typeMismatch'    => !value.empty? && ((type == 'email' && !URI::MailTo::EMAIL_REGEXP.match?(value)) ||
                                                   (type == 'url'   && !URL_RE.match?(value))),
            'patternMismatch' => !value.empty? && pattern && !value.match?(/\A(?:#{pattern})\z/),
            'tooLong'         => ml && value.length > ml,
            'tooShort'        => !value.empty? && minl && value.length < minl,
            'rangeUnderflow'  => numeric && mn && numeric < mn,
            'rangeOverflow'   => numeric && mx && numeric > mx,
            'stepMismatch'    => false,
            'badInput'        => false,
            'customError'     => false
          }.tap { |s| s['valid'] = s.values.none? }
        end

        def validation_message(node, v = compute_validity(node))
          return ''                                       if v['valid']
          return 'Please fill out this field.'            if v['valueMissing']
          return 'Please match the requested format.'     if v['patternMismatch']
          return 'Please use a valid email address.'      if v['typeMismatch'] && (node['type'] || '').downcase == 'email'
          return 'Please use a valid URL.'                if v['typeMismatch'] && (node['type'] || '').downcase == 'url'
          return "Please shorten this text to #{node['maxlength']} characters or less." if v['tooLong']
          return "Please lengthen this text to #{node['minlength']} characters or more." if v['tooShort']
          return "Value must be greater than or equal to #{node['min']}." if v['rangeUnderflow']
          return "Value must be less than or equal to #{node['max']}."    if v['rangeOverflow']
          'Please match the requested format.'
        end

        def label_target(label)
          if (target_id = label['for']) && !target_id.empty?
            return @document.at_xpath('.//*[@id=$id]', nil, id: target_id.to_s)
          end
          label.css('input,select,textarea,button').first
        end

        # DOM compareDocumentPosition bitmask. Cases libraries branch on:
        # DISCONNECTED / FOLLOWING / PRECEDING / CONTAINS / CONTAINED_BY.
        DOC_POS_DISCONNECTED = 1
        DOC_POS_PRECEDING    = 2
        DOC_POS_FOLLOWING    = 4
        DOC_POS_CONTAINS     = 8
        DOC_POS_CONTAINED_BY = 16

        def compare_positions(a, b)
          return DOC_POS_DISCONNECTED if a.nil? || b.nil?
          return 0 if a == b
          return DOC_POS_CONTAINS     if b.ancestors.include?(a)
          return DOC_POS_CONTAINED_BY if a.ancestors.include?(b)
          # Nokogiri::XML::Node#<=> walks via libxml2 (cheaper than a Ruby
          # traverse), returning -1/0/1 within a document or nil across.
          cmp = (a <=> b)
          return DOC_POS_DISCONNECTED if cmp.nil?
          cmp.negative? ? DOC_POS_PRECEDING : DOC_POS_FOLLOWING
        end

        def node_type_for(node)
          return 9  if node.is_a?(Nokogiri::XML::Document)
          return 1  if node.element?
          return 3  if node.is_a?(Nokogiri::XML::Text)
          return 8  if node.is_a?(Nokogiri::XML::Comment)
          return 11 if node.is_a?(Nokogiri::XML::DocumentFragment)
          0
        end

        # `root:` flag walks ancestors via style_hidden? once at the call
        # site; descendants only check their *own* hidden / style attrs,
        # turning visible_text from O(N×depth) into O(N).
        def collect_visible_text(node, out, root:)
          return if node.nil?
          if node.is_a?(Nokogiri::XML::Text)
            out << node.text.gsub(INLINE_WHITESPACE_RE, ' ')
            return
          end
          return unless node.respond_to?(:children)
          return if INVISIBLE_TAGS.include?(node.name)
          if node.respond_to?(:[])
            return if root ? style_hidden?(node) : self_hidden?(node)
          end
          if node.name == 'br'
            out << "\n"
            return
          end
          block = BLOCK_TAGS.include?(node.name)
          out << "\n" if block && !out.empty? && !out.end_with?("\n")
          node.children.each { |c| collect_visible_text(c, out, root: false) }
          out << "\n" if block && !out.end_with?("\n")
        end

        def self_hidden?(node)
          return true if node['hidden']
          style = node['style'].to_s
          style.match?(DISPLAY_NONE_RE) || style.match?(VISIBILITY_HIDDEN_RE)
        end

        DISPLAY_NONE_RE       = /display\s*:\s*none/i
        VISIBILITY_HIDDEN_RE  = /visibility\s*:\s*hidden/i

        def style_hidden?(node)
          cur = node
          while cur.respond_to?(:[])
            return true if cur['hidden']
            style = cur['style'].to_s
            return true if style.match?(DISPLAY_NONE_RE)
            return true if style.match?(VISIBILITY_HIDDEN_RE)
            cur = cur.respond_to?(:parent) ? cur.parent : nil
          end
          false
        end
      end
    end
  end
end
