require 'json'
require 'nokogiri'
require 'rack/mime'
require 'rack/mock'
require 'securerandom'
require 'set'
require_relative 'handle_table'
require_relative 'js_runtime'

module Capybara
  module Simulated
    module V2
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
          navigate(:get, resolve(url))
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

        VISIBLE_TEXT_SKIP_TAGS = %w[script style head template noscript].to_set.freeze

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
          node && node[name]
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
            else
              node['value'] = value.to_s
            end
          when 'textarea'
            node.content = value.to_s
          end
          true
        end

        def file_picks_for(handle)
          @file_picks[handle] || []
        end

        def select_option(handle)
          opt = lookup_node(handle)
          return false unless opt && opt.name == 'option'
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
          return false unless select && select['multiple']
          opt.delete('selected')
          true
        end

        def visible?(handle)
          node = lookup_node(handle)
          return false if node.nil?
          %w[head script style].include?(node.name) ? false : !style_hidden?(node)
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

        def click(handle)
          node = lookup_node(handle)
          return false if node.nil?
          # Fire 'click' before the default action — handlers may
          # preventDefault() to suppress navigation / form submit.
          return true unless dispatch_event(handle, 'click')
          case node.name
          when 'a'
            href = node['href']
            navigate(:get, resolve(href)) if href
            true
          when 'button', 'input'
            click_form_control(node)
          when 'label'
            target = label_target(node)
            target ? click(@handles.track(target)) : false
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
          changed = set_value(handle, value)
          return changed unless changed && @js
          dispatch_event(handle, 'input',  bubbles: true, cancelable: false)
          dispatch_event(handle, 'change', bubbles: true, cancelable: false)
          changed
        end

        # Best-effort send_keys: appends each printable key to the field's
        # current value, fires keydown / keypress / keyup per key, then
        # input + change. Special tokens (:enter, :tab, :backspace, etc.)
        # are passed as the event's `key` field but produce no value change
        # except :backspace which trims one trailing char.
        def send_keys(handle, keys)
          node = lookup_node(handle)
          return false if node.nil?
          current = (node.name == 'textarea' ? node.text : node['value']).to_s
          keys.each do |k|
            case k
            when Symbol
              current = current[0...-1] if k == :backspace && !current.empty?
              dispatch_event(handle, 'keydown')
              dispatch_event(handle, 'keyup')
            when String
              k.each_char do |c|
                current << c
                dispatch_event(handle, 'keydown')
                dispatch_event(handle, 'keypress')
                dispatch_event(handle, 'keyup')
              end
            end
          end
          set_value(handle, current)
          dispatch_event(handle, 'input',  bubbles: true, cancelable: false)
          dispatch_event(handle, 'change', bubbles: true, cancelable: false)
          true
        end

        def evaluate_script(code, args = [])
          marshalled = args.map { |a| marshal_script_arg(a) }
          js.eval("__evalScript(#{code.to_json}, #{marshalled.to_json})")
        end

        def marshal_script_arg(arg)
          case arg
          when Capybara::Driver::Node then {'__elementHandle' => arg.native}
          when Array                  then arg.map { |x| marshal_script_arg(x) }
          when Hash                   then arg.transform_values { |v| marshal_script_arg(v) }
          else arg
          end
        end

        # Fire a JS event at `handle`. Returns true unless a listener called
        # `preventDefault()`. Short-circuits when JS isn't booted, when no
        # listener is registered for this event type, *and* no observer is
        # watching for the side-effects — the cheap path covers the bulk of
        # plain rack_test-style flows where most events are nobody's problem.
        def dispatch_event(handle, type, bubbles: true, cancelable: true)
          return true unless @js && handle
          return true unless @listened_types.include?(type) || @mutation_recording
          init = {bubbles: bubbles, cancelable: cancelable}
          result = js.eval("__dispatchFromRuby(#{handle}, #{type.to_json}, #{init.to_json})")
          settle
          result
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
            js.eval("__deliverMutations(#{records.to_json})")
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
          else
            warn "[capybara-simulated/v2] unsupported dom op: #{op}" if ENV['CSIM_V2_DEBUG']
            nil
          end
        end


        def lookup_node(handle)
          handle && @handles.lookup(handle)
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
          env  = Rack::MockRequest.env_for(uri.request_uri, **opts)
          status, headers, body_iter = @app.call(env)
          response_body = +''
          if body_iter.respond_to?(:each)
            body_iter.each { |chunk| response_body << chunk.to_s }
          else
            response_body << body_iter.to_s
          end
          body_iter.close if body_iter.respond_to?(:close)

          ingest_set_cookie(headers)

          if (300..399).cover?(status) && (loc = (headers['location'] || headers['Location']))
            @current_url = resolve(loc, base: req.url)
            return replay(Request.new(method: :get, url: @current_url, body: nil, content_type: nil))
          end

          @status_code      = status
          @response_headers = headers
          @current_url      = req.url
          # Handle integers get reused across documents, so the old file-pick
          # map would silently re-attach to whatever now lives at those ints.
          @file_picks.clear
          @document    = Nokogiri::HTML5(response_body)
          @handles.reset!(@document)
          # Run inline `<script>` tags only when the page actually has any —
          # avoids paying QuickJS cold-start on rack_test-style flows. Reset
          # the virtual clock so timers from the previous page can't fire on
          # this one, and drain afterwards to settle initial setTimeout(0)s.
          if @document.at_xpath('.//script[not(@src)]')
            js.reset_page
            reset_per_page_state
            js.run_inline_scripts(@document)
            settle
          elsif @js
            @js.reset_page
            reset_per_page_state
          end
          status
        end

        def resolve(url, base: @current_url)
          return url if url =~ %r{\A[a-z]+://}i
          URI.join(base || DEFAULT_HOST, url).to_s
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
          method = (form['method'] || 'get').downcase
          action = resolve(form['action'].to_s.empty? ? @current_url.to_s : form['action'])
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

        # Yields each submittable form-control entry as
        # `[name, type, value, picks]` — `picks` is the array of paths for a
        # file input, otherwise nil. serialize_form / build_multipart consume
        # this single walk so the field-selection rules stay in one place.
        def each_form_field(form, submitter)
          form.css('input, textarea, select, button').each do |field|
            name = field['name']
            next if name.nil? || name.empty? || field['disabled']
            type = (field['type'] || (field.name == 'button' ? 'submit' : nil) || field.name).downcase
            case type
            when 'submit', 'image', 'button', 'reset'
              next unless field == submitter
              yield name, type, field['value'].to_s, nil
            when 'checkbox', 'radio'
              yield name, type, (field['value'] || 'on'), nil if field['checked']
            when 'select'
              field.css('option').each do |opt|
                yield name, type, (opt['value'] || opt.text), nil if opt['selected']
              end
            when 'textarea'
              yield name, type, field.text, nil
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

        def label_target(label)
          if (target_id = label['for']) && !target_id.empty?
            return @document.at_xpath('.//*[@id=$id]', nil, id: target_id.to_s)
          end
          label.css('input,select,textarea,button').first
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
          return if VISIBLE_TEXT_SKIP_TAGS.include?(node.name)
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
