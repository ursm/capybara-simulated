# frozen_string_literal: true

require 'digest'
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
    # Raised when a Nokogiri node held by a Node has been removed from
    # the document (e.g. via `el.replaceWith(...)` from JS). Driver
    # exposes this as an `invalid_element_error`, so Capybara's
    # synchronize wrapper catches it and reloads the cached element.
    class StaleElement < Capybara::ElementNotFound; end

    DEFAULT_HOST    = 'http://www.example.com'
    BLANK_DOCUMENT  = '<!doctype html><html><body></body></html>'

    Request = Data.define(:method, :url, :body, :content_type, :referer)

    # Owns the Nokogiri document, the in-process Rack client, and the
    # lazy QuickJS runtime. Capybara DSL queries hit Nokogiri directly;
    # user JS (when present) sees a thin DOM proxy backed by `dom_op`.
    class Browser
      attr_reader   :app, :status_code, :response_headers
      attr_accessor :mutation_recording, :timers_active

      def current_url
        tick_real_time
        @current_url
      end

      def initialize(app, features: [])
        @app                = app
        @extra_js_features  = features
        @document           = Nokogiri::HTML5(BLANK_DOCUMENT)
        @handles            = HandleTable.new(@document)
        @js                 = nil
        @current_url        = nil
        @status_code        = nil
        @response_headers   = {}
        @history            = []
        @history_idx        = -1
        # Wall-clock anchor — `tick_real_time` walks the virtual JS clock
        # forward by Capybara's polling interval so `setTimeout(N)` fires
        # once a test has actually waited N ms.
        @last_tick_ts       = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_until      = nil  # sticky window — see Browser#polling?
        @cookies            = {}
        @file_picks         = {}   # handle -> [path, ...] for <input type="file">
        @modal_handlers     = []   # innermost handler matches the next modal, pops, then bubbles outward
        @resource_cache     = {}   # URL -> response body for <script src=...> etc.
        @importmap          = empty_importmap
        @module_cache       = {}   # URL -> rewritten module source (cleared on reset!)
        @shadow_roots       = {}   # host_handle -> Nokogiri::HTML5::DocumentFragment
        @shadow_root_set    = Set.new  # mirrors @shadow_roots.values for O(1) ancestor-walk checks
        @focused_handle     = nil  # currently-focused element handle
        @hovered_handle     = nil  # last element passed to `hover` (drives mouseleave on the next hover)
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
        @js ||= JsRuntime.new(self, extra_features: @extra_js_features)
      end

      def visit(url)
        # Address-bar navigation — no Referer, regardless of where we
        # were before. Link clicks / form submits / location.assign
        # take the @current_url default.
        navigate(:get, resolve_against_current(url), referer: nil)
      end

      def refresh
        req = current_request
        replay(req) if req
      end

      def go_back
        return if @history_idx <= 0
        @history_idx -= 1
        replay(current_request)
      end

      def go_forward
        return if @history_idx >= @history.size - 1
        @history_idx += 1
        replay(current_request)
      end

      def reset!
        @document         = Nokogiri::HTML5(BLANK_DOCUMENT)
        @handles.reset!(@document)
        @current_url      = nil
        @status_code      = nil
        @response_headers = {}
        @history.clear
        @history_idx      = -1
        @last_tick_ts     = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_until    = nil
        @cookies.clear
        @file_picks.clear
        @resource_cache.clear
        @importmap = empty_importmap
        @module_cache.clear
        @shadow_roots.clear
        @shadow_root_set.clear
        @focused_handle = nil
        @hovered_handle = nil
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
        tick_real_time
        root = lookup_node(context) || @document
        # Capybara emits `(...)[]` (an empty predicate) when `text:` is a
        # Symbol with `wait? = true` — `xpath_text_conditions` returns
        # nil and the `[#{nil}]` interpolation collapses. libxml2's
        # parser rejects the empty predicate; strip it so the rest of
        # the expression matches as if no text filter was given.
        xpath = xpath.to_s.sub(/\)\[\]\z/, ')').sub(/\A\((.*)\)\z/, '\1')
        root.xpath(xpath).filter_map { |n| @handles.track(n) }
      end

      def find_css(css, context = nil)
        tick_real_time
        root = lookup_node(context) || @document
        stripped, ci_predicates = strip_case_insensitive_attr_flags(css)
        matches = root.css(stripped, css_pseudo_handlers)
        matches = matches.select {|n| ci_predicates.all? {|p| ci_attr_match?(n, p) } } unless ci_predicates.empty?
        matches.filter_map {|n| @handles.track(n) }
      end

      # Nokogiri's CSS parser doesn't grok the Selectors-Level-4 case-
      # insensitive flag (`[class*='X' i]`). Strip the trailing `i`/`s`
      # so the parser is happy, and remember the predicate so we can
      # case-fold the comparison ourselves on the result set.
      CASE_INSENSITIVE_ATTR_RE = /\[\s*([\w-]+)\s*([~|^$*]?=)\s*(['"])(.*?)\3\s+([is])\s*\]/i

      def strip_case_insensitive_attr_flags(css)
        predicates = []
        stripped = css.to_s.gsub(CASE_INSENSITIVE_ATTR_RE) do
          name, op, val, flag = $1, $2, $4, $5
          predicates << {name: name, op: op, val: val, flag: flag.downcase}
          # Reduce to attribute-presence; the real predicate runs as a
          # post-filter below so case-folding is honoured.
          "[#{name}]"
        end
        [stripped, predicates]
      end

      # Namespace-prefixed attributes like Turbo's `a[xlink\:href]` trip
      # Nokogiri's CSS-to-XPath converter (libxml2's XPath 1.0 doesn't
      # grok the `*:name` form). Catch those rather than letting the
      # error bubble into JS — the SVG-namespaced cases never match in
      # our documents anyway.
      SELECTOR_ERRORS = [
        Nokogiri::CSS::SyntaxError,
        Nokogiri::XML::XPath::SyntaxError,
        ArgumentError
      ].freeze

      CHECKABLE_INPUT_TYPES = %w[checkbox radio].freeze

      # Write or remove an attribute on `node` (nil value removes).
      # Returns the previous attribute value so the JS side can decide
      # whether to fire CE attributeChangedCallback. No-ops when the
      # value would be unchanged — matches real-browser semantics and
      # spares observers a redundant notification.
      def write_attribute(node, handle, name, value)
        return nil unless node.element?
        old = node[name]
        return old if old == value
        if value.nil?
          node.delete(name)
        else
          node[name] = value
        end
        record_attribute(handle, name, old)
        old
      end

      # Try the whole selector first, then fall back to per-branch
      # evaluation only if Nokogiri rejects it — Turbo's
      # `a[href], a[xlink\:href]` would otherwise drop the leading
      # branch when the namespaced second branch fails CSS-to-XPath.
      # CssPseudoHandlers is threaded through so JS-side queries see the
      # same `:checked` / `:disabled` / etc. set the Ruby DSL does.
      def safe_at_css(node, selector)
        return nil unless node.respond_to?(:at_css)
        node.at_css(strip_scope(selector), css_pseudo_handlers)
      rescue *SELECTOR_ERRORS
        css_split(selector).each {|s|
          hit = node.at_css(strip_scope(s), css_pseudo_handlers) rescue next
          return hit if hit
        }
        nil
      end

      def safe_css(node, selector)
        return [] unless node.respond_to?(:css)
        node.css(strip_scope(selector), css_pseudo_handlers)
      rescue *SELECTOR_ERRORS
        css_split(selector).flat_map {|s| node.css(strip_scope(s), css_pseudo_handlers) rescue [] }
      end

      # `:scope` is the spec-shaped reference to the query origin; jQuery
      # 3 / Sizzle prepends it to relative selectors like `> *`, but
      # Nokogiri's CSS-to-XPath compiler chokes on it. Stripping it is
      # safe for the descendant-or-self queries our `node.css` already
      # performs.
      SCOPE_RE = /:scope\s*/i
      def strip_scope(selector)
        s = selector.to_s
        s.match?(SCOPE_RE) ? s.gsub(SCOPE_RE, '') : s
      end

      # Nokogiri's `matches?` doesn't accept a custom-pseudo handler the
      # way `css` does, so when the selector references one of our
      # registered pseudos we route through `parent.css(handler).include?`.
      # Nokogiri's `matches?` doesn't accept a custom-pseudo handler the
      # way `css` does, so when the selector references one of our
      # registered pseudos — or when matches? itself can't compile a
      # multi-branch selector like `a[href], a[xlink\:href]` — we fall
      # through to a `parent.css(handler).include?` lookup.
      def safe_matches?(node, selector)
        s = selector.to_s
        return node.matches?(s) if !s.match?(REGISTERED_PSEUDO_RE) && !s.include?(',')
        css_match_via_parent(node, s)
      rescue *SELECTOR_ERRORS
        css_match_via_parent(node, s)
      end

      # `parent.css(handler).include?` lookup — the only way to evaluate
      # selectors with custom pseudo-classes (Nokogiri's `matches?`
      # doesn't accept the handler) or selectors Nokogiri can't compile
      # whole (e.g. `a[href], a[xlink\:href]` — fall back to per-branch).
      def css_match_via_parent(node, selector)
        parent = node.respond_to?(:parent) ? node.parent : nil
        return false unless parent.respond_to?(:css)
        parent.css(selector, css_pseudo_handlers).any? { it.equal?(node) }
      rescue *SELECTOR_ERRORS
        css_split(selector).any? {|branch|
          (parent.css(branch, css_pseudo_handlers) rescue []).any? { it.equal?(node) }
        }
      end

      REGISTERED_PSEUDO_RE = /:(?:checked|selected|disabled|enabled|required|optional)\b/.freeze

      # Top-level comma split — bracket-content / parens are safe to
      # ignore for the kinds of selectors we see (Turbo / Stimulus
      # don't nest comma selector groups inside attribute predicates).
      def css_split(selector)
        selector.to_s.split(',').map(&:strip).reject(&:empty?)
      end

      ID_SAFE_RE  = /\A[A-Za-z0-9_-]+\z/.freeze
      ID_ESCAPE_RE = /[^A-Za-z0-9_-]/.freeze

      def escape_id_selector(id)
        return id if ID_SAFE_RE.match?(id)
        id.gsub(ID_ESCAPE_RE) { |c| "\\#{c}" }
      end

      def ci_attr_match?(node, p)
        return false unless node.respond_to?(:[])
        actual = node[p[:name]].to_s
        # Spec: `s` = case-sensitive (default), `i` = case-insensitive.
        a, v = p[:flag] == 'i' ? [actual.downcase, p[:val].downcase] : [actual, p[:val]]
        case p[:op]
        when '='  then a == v
        when '*=' then a.include?(v)
        when '^=' then a.start_with?(v)
        when '$=' then a.end_with?(v)
        when '~=' then a.split(/\s+/).include?(v)
        when '|=' then a == v || a.start_with?("#{v}-")
        else false
        end
      end

      # Nokogiri's CSS parser routes unknown pseudo-classes
      # (`:disabled`, `:checked`, `:enabled`, etc.) through
      # `nokogiri:<name>(.)` custom XPath calls. We register handlers
      # here so common HTML form pseudo-selectors work in find_css.
      # `:disabled` honours fieldset / select / optgroup propagation
      # via Browser#disabled?.
      class CssPseudoHandlers
        def initialize(browser)
          @browser = browser
        end

        def disabled(node_set)
          node_set.select { |n| @browser.disabled?(@browser.handles_track(n)) }
        end

        def enabled(node_set)
          node_set.reject { |n| @browser.disabled?(@browser.handles_track(n)) }
        end

        def checked(node_set)
          node_set.select { |n| n.respond_to?(:[]) && n['checked'] }
        end

        def selected(node_set)
          node_set.select { |n| n.respond_to?(:[]) && n['selected'] }
        end

        def required(node_set)
          node_set.select { |n| n.respond_to?(:[]) && n['required'] }
        end

        def optional(node_set)
          node_set.reject { |n| n.respond_to?(:[]) && n['required'] }
        end

        # `*:focus` — the currently-focused element. We track focus on
        # the Browser side via @focused_handle; resolve back to its node
        # and intersect with the candidate set.
        def focus(node_set)
          focused = @browser.focused_node
          return [] unless focused
          node_set.select { |n| n.equal?(focused) }
        end
      end

      # Exposed for CssPseudoHandlers — Browser#disabled? takes a handle,
      # so handlers translate Nokogiri nodes back through the table.
      def handles_track(node)
        @handles.track(node)
      end

      # Stateless apart from the immutable `@browser` reference, so one
      # instance per Browser is enough. Hot-path queries (querySelector,
      # find_css, matches) all funnel through this.
      def css_pseudo_handlers
        @css_pseudo_handlers ||= CssPseudoHandlers.new(self)
      end

      # Exposed for CssPseudoHandlers — `*:focus` needs the focused
      # node, not just its handle.
      def focused_node
        @focused_handle ? lookup_node(@focused_handle) : nil
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
      # normalization is the caller's job (Node mixes in
      # Capybara::Node::WhitespaceNormalizer).
      def visible_text(handle)
        node = lookup_node(handle)
        return '' if node.nil?
        out = String.new
        collect_visible_text(node, out, root: true)
        out
      end

      def tag_name(handle)
        node = lookup_node(handle)
        return 'ShadowRoot' if @shadow_root_set.include?(node)
        (node&.name || '').downcase
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
        when 'input'
          type = (node['type'] || 'text').downcase
          # checkbox / radio default to 'on' when no value attribute is set.
          return node['value'] || 'on' if %w[checkbox radio].include?(type)
          # The DOM `.value` property is the empty string when the value
          # attribute is unset; coerce so callers can rely on String shape.
          node['value'] || ''
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
        # readonly text inputs / textareas silently reject writes; the
        # `readonly` attribute does NOT apply to checkboxes / radios /
        # range / etc. per the HTML spec, so don't short-circuit those.
        if node['readonly'] && !readonly_exempt?(node)
          return false
        end
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
            # innerHTML / be visible to user JS). Drop blank paths
            # (Redmine's attachments.js resets the dummy `<input>` via
            # `value = ''` after cloning the real picker into a new entry;
            # without the reject the dummy's empty-path entry hits
            # `File.binread('')` in `build_multipart`).
            @file_picks[handle] = Array(value).map(&:to_s).reject(&:empty?)
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
        each_ancestor(node) do |cur|
          ce = cur['contenteditable']
          return true  if ce && ce != 'false'
          return false if ce == 'false'
        end
        false
      end

      # Walks `node` and its ancestors, yielding each element until the
      # parent chain runs out (Document doesn't respond_to `[]`). The
      # Nokogiri `respond_to?(:parent)` guard is what stops detached
      # nodes from blowing up — `node.parent` on an orphan returns nil
      # but `nil.parent` would NoMethodError.
      def each_ancestor(node)
        cur = node
        while cur.respond_to?(:[])
          yield cur
          cur = cur.respond_to?(:parent) ? cur.parent : nil
        end
      end

      def file_picks_for(handle)
        @file_picks[handle] || []
      end

      # Range#cloneContents (delegated from JS). Walks from
      # (start_container, start_offset) to (end_container, end_offset)
      # in tree order, partial-cloning text-node substrings and
      # element-children-by-index at the boundaries and full-cloning
      # interior siblings.
      def clone_range_into(fragment, start_container, start_off, end_container, end_off)
        if start_container == end_container
          clone_same_container_into(fragment, start_container, start_off, end_off)
          return
        end
        ancestor = common_ancestor(start_container, end_container) or return
        start_child = start_container == ancestor ? nil : ancestor_child(ancestor, start_container)
        end_child   = end_container   == ancestor ? nil : ancestor_child(ancestor, end_container)
        if start_child && end_child && start_child == end_child
          # Both boundaries inside the same top-level subtree of the ancestor.
          fragment << clone_subtree_between(start_child, start_container, start_off, end_container, end_off)
          return
        end
        children = ancestor.children
        if start_child
          fragment << clone_subtree_to_end(start_child, start_container, start_off)
          start_idx = (children.index(start_child) || 0) + 1
        else
          start_idx = start_off
        end
        end_idx = end_child ? (children.index(end_child) || children.length) : end_off
        children[start_idx...end_idx]&.each { |c| fragment << c.dup(1) }
        if end_child
          fragment << clone_subtree_from_start(end_child, end_container, end_off)
        end
      end

      def clone_same_container_into(fragment, container, start_off, end_off)
        if text_node?(container)
          fragment << Nokogiri::XML::Text.new(container.content[start_off...end_off].to_s, @document)
        elsif container.respond_to?(:children)
          container.children[start_off...end_off]&.each { |c| fragment << c.dup(1) }
        end
      end

      # Clone `subtree`, including only content from (boundary, offset)
      # to the end of `subtree`.
      def clone_subtree_to_end(subtree, boundary, offset)
        return text_slice(subtree, offset, nil) if subtree == boundary && text_node?(subtree)
        shell = subtree.dup(0)
        if subtree == boundary
          subtree.children[offset..]&.each { |c| shell << c.dup(1) }
          return shell
        end
        child = ancestor_child(subtree, boundary) or return shell
        idx   = subtree.children.index(child)
        shell << clone_subtree_to_end(child, boundary, offset)
        subtree.children[(idx + 1)..]&.each { |c| shell << c.dup(1) } if idx
        shell
      end

      # Clone `subtree`, including only content from the start of
      # `subtree` to (boundary, offset).
      def clone_subtree_from_start(subtree, boundary, offset)
        return text_slice(subtree, 0, offset) if subtree == boundary && text_node?(subtree)
        shell = subtree.dup(0)
        if subtree == boundary
          subtree.children[0...offset]&.each { |c| shell << c.dup(1) }
          return shell
        end
        child = ancestor_child(subtree, boundary) or return shell
        idx   = subtree.children.index(child)
        subtree.children[0...idx]&.each { |c| shell << c.dup(1) } if idx
        shell << clone_subtree_from_start(child, boundary, offset)
        shell
      end

      # Both boundaries land inside the same subtree below the common
      # ancestor — recurse pairwise.
      def clone_subtree_between(subtree, sc, so, ec, eo)
        if subtree == sc && subtree == ec
          if text_node?(subtree)
            return text_slice(subtree, so, eo)
          else
            shell = subtree.dup(0)
            subtree.children[so...eo]&.each { |c| shell << c.dup(1) }
            return shell
          end
        end
        shell = subtree.dup(0)
        s_child = subtree == sc ? nil : ancestor_child(subtree, sc)
        e_child = subtree == ec ? nil : ancestor_child(subtree, ec)
        if s_child && e_child && s_child == e_child
          shell << clone_subtree_between(s_child, sc, so, ec, eo)
          return shell
        end
        children = subtree.children
        if s_child
          shell << clone_subtree_to_end(s_child, sc, so)
          start_idx = (children.index(s_child) || 0) + 1
        else
          start_idx = so
        end
        end_idx = e_child ? (children.index(e_child) || children.length) : eo
        children[start_idx...end_idx]&.each { |c| shell << c.dup(1) }
        shell << clone_subtree_from_start(e_child, ec, eo) if e_child
        shell
      end

      def text_slice(node, lo, hi)
        Nokogiri::XML::Text.new((node.content[lo...(hi || node.content.length)] || ''), @document)
      end

      def text_node?(n)
        n.respond_to?(:type) && (n.type == Nokogiri::XML::Node::TEXT_NODE || n.type == Nokogiri::XML::Node::CDATA_SECTION_NODE)
      end

      # Walks `descendant` upward stopping when it's a direct child of
      # `ancestor`. Returns nil if `descendant` isn't actually a
      # descendant.
      def ancestor_child(ancestor, descendant)
        cur = descendant
        while cur
          parent = cur.respond_to?(:parent) ? cur.parent : nil
          return cur if parent == ancestor
          cur = parent
        end
        nil
      end

      def common_ancestor(a, b)
        seen = Set.new
        cur = a
        while cur
          seen << cur
          cur = cur.respond_to?(:parent) ? cur.parent : nil
        end
        cur = b
        while cur
          return cur if seen.include?(cur)
          cur = cur.respond_to?(:parent) ? cur.parent : nil
        end
        nil
      end

      # HTML spec: readonly only blocks user input on text-y inputs and
      # textareas. checkbox / radio / range / file / etc. ignore it.
      READONLY_BLOCKS_TYPES = %w[
        text search url tel email password
        date month week time datetime-local number
      ].to_set.freeze

      def readonly_exempt?(node)
        return false if node.name == 'textarea'
        return true  unless node.name == 'input'
        !READONLY_BLOCKS_TYPES.include?((node['type'] || 'text').downcase)
      end

      # Mirrors document.activeElement: the focused element, or body
      # when nothing has focus (HTML spec).
      def active_element_handle
        tick_real_time
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
          dispatch_event(blur_handle, 'blur',     bubbles: false, cancelable: false)
          dispatch_event(blur_handle, 'focusout', bubbles: true,  cancelable: false)
        end
        @focused_handle = handle
        dispatch_event(handle, 'focus',   bubbles: false, cancelable: false)
        # focusin/focusout shadow focus/blur but bubble; jQuery 3.x
        # rewrites delegated `$(document).on('focus', selector, ...)`
        # registrations to focusin, so without them Tribute / atwho
        # autocomplete attachments never fire.
        dispatch_event(handle, 'focusin', bubbles: true,  cancelable: false)
      end

      def blur(handle)
        return unless @focused_handle == handle
        @focused_handle = nil
        dispatch_event(handle, 'blur',     bubbles: false, cancelable: false)
        dispatch_event(handle, 'focusout', bubbles: true,  cancelable: false)
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
        n    = Float(value) rescue (return value)
        min  = Float(node['min'])  rescue nil
        max  = Float(node['max'])  rescue nil
        step = Float(node['step']) rescue nil
        n = min if min && n < min
        n = max if max && n > max
        # HTML5 step-snapping: ranges are anchored to `min` (default 0)
        # and round to the nearest valid step. `<input type="range">`
        # snaps unconditionally — `type="number"` only validates.
        if step && step > 0 && node['type'].to_s.downcase == 'range'
          base = min || 0.0
          n    = base + ((n - base) / step).round * step
          n    = max if max && n > max
        end
        n == n.to_i ? n.to_i : n
      end

      def select_option(handle)
        opt = lookup_node(handle)
        return false unless opt && opt.name == 'option'
        # Browsers don't let users select a disabled option.
        return false if opt['disabled']
        select = opt.ancestors('select').first or return false
        set_option_selected(opt, true)
        dispatch_input_change(@handles.track(select))
        true
      end

      def set_option_selected(opt, on)
        return unless opt && opt.name == 'option'
        if on
          select = opt.ancestors('select').first
          if select && !select['multiple']
            select.css('option').each { |o| o.delete('selected') }
          end
          opt['selected'] = 'selected'
        else
          opt.delete('selected')
        end
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
        dispatch_input_change(@handles.track(select))
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
        summary_seen = false
        each_ancestor(node) do |cur|
          return true  if cur.is_a?(Nokogiri::XML::Document)
          return false if self_hidden?(cur)
          return false if cur.name == 'details' && !cur['open'] && !summary_seen
          summary_seen = true if cur.name == 'summary'
        end
        true
      end

      # `<option>` is disabled if any ancestor `<optgroup>`/`<select>` is
      # disabled. Other form controls inherit `disabled` from a wrapping
      # `<fieldset disabled>` *unless* they sit inside its first `<legend>`.
      def disabled?(handle)
        node = lookup_node(handle)
        return false if node.nil? || !node.respond_to?(:[])
        # HTML spec restricts `disabled` to form-association tags plus
        # `<fieldset>` — `<a disabled>` etc. stay clickable.
        return true  if (FORM_CONTROL_TAGS.include?(node.name) || node.name == 'fieldset') && node['disabled']
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
        tick_real_time
        @document.to_html
      end

      def title
        tick_real_time
        @document.at('head > title')&.text || ''
      end

      MODIFIER_KEYS = %i[shift control alt meta command].to_set.freeze

      # `<a>` href schemes that don't trigger a Rack navigation. data:
      # and blob: would 404 against the in-process app; the others
      # are real browser pseudo-protocols (open mail client, dial,
      # run JS) that have no Rack-side equivalent.
      NON_NAVIGABLE_SCHEMES = %w[javascript: mailto: tel: data: blob:].freeze

      def click(handle, modifiers = nil, delay: 0)
        node = lookup_node(handle)
        return false if node.nil?
        # Click on a focusable element steals focus first — matches what
        # browsers do (focus event fires before click for synthetic
        # element.click() / user clicks).
        focus(handle) if node.respond_to?(:name) && FOCUSABLE_TAGS.include?(node.name)
        mods = modifier_init(modifiers)
        fire_mouse_sequence(handle, button: 0, delay: delay, modifiers: mods)
        # Real browsers toggle a checkbox / radio *before* firing click,
        # so listeners (Redmine's `contextMenuClick` reads
        # `target.checked` after a row-checkbox click) see the new state.
        # If the click is preventDefault'd we revert it below.
        prior_checked = pretoggle_form_control(node)
        # Fire 'click' before the default action — handlers may
        # preventDefault() to suppress navigation / form submit.
        unless dispatch_event(handle, 'click', **mouse_init(button: 0), **mods)
          revert_pretoggle(node, prior_checked)
          return true
        end
        case node.name
        when 'a'
          href = node['href']
          return true if href.nil? || href.empty?
          return true if NON_NAVIGABLE_SCHEMES.any? { |s| href.start_with?(s) }
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

      # Real browsers execute a `<script>` on insertion into a connected
      # document. rails-ujs's data-remote handling leans on this — it
      # builds `<script>` from the AJAX body and `head.appendChild`s it.
      # Scripts inside a still-detached fragment must be skipped: jQuery
      # 3.x's `domManip` walks our subtree before splicing it in, and
      # firing them there would run before their sibling fields exist.
      def run_inserted_scripts(root)
        return unless @js && root.respond_to?(:document) && root.document.equal?(@document)
        scripts = root.name == 'script' ? [root] : (root.respond_to?(:css) ? root.css('script').to_a : [])
        scripts.each do |s|
          next unless s.ancestors.include?(@document) && runnable_script_type?(s['type'])
          @js.run_classic_script(self, s)
        end
      end

      # jQuery 3.x's `domManip` neuters scripts during fragment build by
      # prefixing their type with `true/` or `false/` so the browser
      # won't auto-execute on insert; it then runs them itself via
      # `DOMEval` (or restores the type and lets the browser do it).
      # Strip the prefix before the classic-type check so we run those
      # bodies once, on the post-splice walk.
      def runnable_script_type?(type)
        type = type.to_s.sub(%r{\A(?:true|false)/}, '')
        JsRuntime::SCRIPT_TYPES_CLASSIC.include?(type)
      end

      # Fire input + change after a user-driven value change. Mirrors what
      # Selenium / a real browser do for `fill_in` / `set`. JS-driven writes
      # via `setValue` dom_op skip this — that path is the JS author's call.
      def set_value_with_events(handle, value)
        node = lookup_node(handle)
        # Checkbox / radio: real browsers toggle the input *before*
        # firing click, so listeners reading `target.checked` (Redmine's
        # `contextMenuClick`) see the new state. preventDefault reverts.
        if node && node.name == 'input' &&
           %w[checkbox radio].include?((node['type'] || '').downcase)
          was_checked = !!node['checked']
          now_checked = !!value
          set_value(handle, now_checked)
          unless dispatch_event(handle, 'click', **mouse_init(button: 0))
            set_value(handle, was_checked)
            return was_checked
          end
          if now_checked != was_checked
            # Stimulus's default action event for radio / checkbox is 'input', not 'change'.
            dispatch_event(handle, 'input',  bubbles: true, cancelable: false)
            dispatch_event(handle, 'change', bubbles: true, cancelable: false)
          end
          return true
        end
        # Focus the field first — fill_in / set on a real browser implies
        # clicking into the field, which fires focus before input/change.
        focus(handle)
        # Trailing \n on a single-input text form submits the form (browser
        # default behaviour for Enter in a single-field form). Strip the \n
        # before storing the value so the submitted body doesn't carry it.
        submit_after = should_submit_on_enter?(node, value)
        changed = set_value(handle, submit_after ? value.to_s.chomp("\n") : value)
        return changed unless changed && @js
        dispatch_input_change(handle)
        # Tail keydown / keyup approximate the "user finished typing"
        # signal that autocomplete / mention libraries (Tribute.js,
        # atwho, etc.) hook. They look at `event.key` to decide whether
        # the most recent keystroke was a trigger character (`#`, `@`,
        # …), so seed the event with the last character of the typed
        # value. Better than nothing for libraries that fire on the
        # final char; per-keystroke replay is out of scope.
        dispatch_key_pair(handle, value)
        submit_form(handle) if submit_after
        changed
      end

      def dispatch_key_pair(handle, value)
        last = value.is_a?(String) ? value[-1] : nil
        init = last ? {key: last, keyCode: last.ord, which: last.ord} : {}
        dispatch_event(handle, 'keydown', bubbles: true, cancelable: true, **init)
        dispatch_event(handle, 'keyup',   bubbles: true, cancelable: true, **init)
      end

      TEXT_LIKE_INPUT_TYPES = %w[text email password search tel url].to_set.freeze

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

      # `KeyboardEvent.key` strings — page handlers gate on these
      # (`if (e.key === 'Escape')` etc.) so they need the user-visible
      # name, not the keyCode.
      SPECIAL_KEY_NAMES = {
        backspace: 'Backspace', tab: 'Tab', enter: 'Enter', return: 'Enter',
        escape: 'Escape', space: ' ',
        left: 'ArrowLeft', up: 'ArrowUp', right: 'ArrowRight', down: 'ArrowDown',
        delete: 'Delete', home: 'Home', end: 'End',
        shift: 'Shift', control: 'Control', alt: 'Alt', meta: 'Meta'
      }.freeze

      # Modifiers that suppress literal character insertion (a real
      # browser treats Ctrl+B as a shortcut, not a typed "b").
      SUPPRESSING_MODIFIERS = Set[:control, :alt, :meta].freeze

      # HTML5 drag-and-drop simulation. Builds a dataTransfer payload
      # from the supplied arguments (file paths → file items, hashes →
      # string items per mime type) and fires dragenter / dragover /
      # drop on the target. Page handlers walk dataTransfer.items /
      # files / getData() to read the dropped content.
      def drop(handle, args)
        items = args.flat_map { |arg| drop_items(arg) }
        js.call('__dropOnto', handle, items)
        settle
        true
      end

      def drop_items(arg)
        case arg
        when Hash
          arg.map { |type, value| {'kind' => 'string', 'type' => type.to_s, 'value' => value.to_s} }
        when ->(x) { x.respond_to?(:to_path) }
          path = arg.to_path
          [{'kind' => 'file', 'name' => File.basename(path), 'path' => path}]
        when String
          [{'kind' => 'file', 'name' => File.basename(arg), 'path' => arg}]
        else
          []
        end
      end

      # Best-effort send_keys. Handles literal Strings, special tokens
      # (:space, :enter, :backspace, :delete, :left, :right, :home, :end,
      # arrow keys), modifier-style tokens (:shift) that fold subsequent
      # input to upper-case, and array bursts ([:shift, 'o']) that scope
      # the modifier to the burst. Maintains a per-call caret position
      # so :left / :right insert at the right offset.
      def send_keys(handle, keys)
        node = lookup_node(handle)
        return false if node.nil?
        start = field_value(node)
        state = {value: start.dup, caret: start.length, modifiers: Set.new}
        keys.each { |k| apply_send_key(handle, state, k) }
        # Skip the commit when no key typed into the field — a shortcut
        # chord like `[:control, 'b']` may have let a JS listener mutate
        # the value itself, and writing our untouched buffer back would
        # clobber that work.
        if state[:value] != start
          set_value(handle, state[:value])
          dispatch_input_change(handle)
        end
        true
      end

      # Modifier handling: a chord array like [:control, 'b'] keeps its
      # modifiers active only for the burst — keydown for the modifier
      # at entry, then keyup at exit, with the chord's middle keys
      # carrying ctrlKey / shiftKey / etc. on their event init. Capybara's
      # send_keys API mirrors WebDriver's, so an outer-level modifier
      # before a String stays sticky until the next array.
      def apply_send_key(handle, state, key)
        case key
        when Array
          mods_before = state[:modifiers].dup
          key.each { |sub| apply_send_key(handle, state, sub) }
          (state[:modifiers] - mods_before).each do |m|
            dispatch_key_event(handle, 'keyup', SPECIAL_KEY_CODES[m], **key_init(state, m))
          end
          state[:modifiers] = mods_before
        when Symbol
          apply_special_key(handle, state, key)
        when String
          if state[:modifiers].intersect?(SUPPRESSING_MODIFIERS) && key.length == 1
            apply_clipboard_shortcut(handle, state, key.downcase)
          else
            text = state[:modifiers].include?(:shift) ? key.upcase : key
            text.each_char { |c| insert_char(handle, state, c) }
          end
        end
      end

      # Handle Ctrl/Cmd + {v|c|x} as the browser's default clipboard
      # action: read or write the JS-side `__clipboardText` buffer and
      # mirror the effect on the field value. We still fire the keydown
      # / keyup pair through `insert_char` so listeners observe the
      # chord even when we synthesise the default action.
      def apply_clipboard_shortcut(handle, state, char)
        insert_char(handle, state, char)  # fires keydown / keyup; suppress flag skips the literal insert
        case char
        when 'v'
          text = js.eval('__getClipboard()').to_s
          splice_at_caret(state, text) unless text.empty?
        when 'c', 'x'
          js.call('__setClipboard', state[:value])
          if char == 'x'
            state[:value] = ''
            state[:caret] = 0
          end
        end
      end

      def apply_special_key(handle, state, key)
        case key
        when :shift, :control, :alt, :meta
          # Track the modifier *before* building init so listeners reading
          # e.ctrlKey on the modifier's own keydown see it as pressed.
          state[:modifiers] << key
          dispatch_key_event(handle, 'keydown', SPECIAL_KEY_CODES[key], **key_init(state, key))
        when :space
          insert_char(handle, state, ' ')
        when :enter, :return
          # Real Enter on a textarea fires `keydown` → `beforeinput`
          # (`insertLineBreak`, cancelable) → default-action newline →
          # `input`. Redmine's list-autofill controller listens for
          # the `beforeinput` and replaces the default action with its
          # own indented list-marker insertion via `setRangeText`, so
          # `\n` only goes in when no listener `preventDefault()`s.
          # Flush the buffer first so the listener reads our typed-so-
          # far value (otherwise it sees the pre-`send_keys` snapshot).
          set_value(handle, state[:value])
          set_caret(handle, state[:caret])
          dispatch_key_event(handle, 'keydown', SPECIAL_KEY_CODES[key], **key_init(state, key))
          allow = dispatch_event(handle, 'beforeinput', cancelable: true, inputType: 'insertLineBreak')
          if allow
            splice_at_caret(state, "\n")
          else
            sync_state_from_dom(handle, state)
          end
          dispatch_key_event(handle, 'keyup', SPECIAL_KEY_CODES[key], **key_init(state, key))
        when :backspace
          if state[:caret] > 0
            state[:value] = state[:value][0, state[:caret] - 1] + state[:value][state[:caret]..]
            state[:caret] -= 1
          end
          fire_special_key_pair(handle, state, key)
        when :delete
          if state[:caret] < state[:value].length
            state[:value] = state[:value][0, state[:caret]] + state[:value][state[:caret] + 1..]
          end
          fire_special_key_pair(handle, state, key)
        when :left  then state[:caret] = [state[:caret] - 1, 0].max
        when :right then state[:caret] = [state[:caret] + 1, state[:value].length].min
        when :home  then state[:caret] = 0
        when :end   then state[:caret] = state[:value].length
        else
          fire_special_key_pair(handle, state, key)
        end
      end

      # Refresh `state[:value]` / `state[:caret]` from the live DOM —
      # needed when a beforeinput / input listener mutated the field
      # itself (e.g. via `setRangeText`) and our buffered state is
      # stale.
      def sync_state_from_dom(handle, state)
        node = lookup_node(handle)
        return unless node
        state[:value] = field_value(node)
        state[:caret] = js.call('__getCaret', handle).to_i
      end

      # Forward the buffered caret to the JS side so a Stimulus
      # listener reading `selectionStart` sees the current position.
      def set_caret(handle, caret)
        js.call('__setCaret', handle, caret.to_i)
      end

      # `<textarea>`'s value lives in its text content; everything else
      # uses the `value` attribute. Centralise the read-current-value
      # idiom shared by `send_keys`, `sync_state_from_dom`, and the
      # validity-state machinery.
      def field_value(node)
        (node.name == 'textarea' ? node.text : node['value']).to_s
      end

      # Splice `text` at `state[:caret]`, advancing the caret. Used by
      # `insert_char`, the `:enter` newline path, and Ctrl+V paste.
      def splice_at_caret(state, text)
        state[:value] = state[:value][0, state[:caret]] + text + state[:value][state[:caret]..]
        state[:caret] += text.length
      end

      # Fire a keydown / keyup pair for a named special key (`:enter`,
      # `:backspace`, etc.). Code defaults to the SPECIAL_KEY_CODES entry,
      # falling back to 0 when no entry exists — matches what real
      # browsers send for unmapped keys.
      def fire_special_key_pair(handle, state, key)
        code = SPECIAL_KEY_CODES[key] || 0
        init = key_init(state, key)
        dispatch_key_event(handle, 'keydown', code, **init)
        dispatch_key_event(handle, 'keyup',   code, **init)
      end

      # Build the KeyboardEvent init bag for the current modifier state,
      # tagged with `key:` for the named special key (or its symbol
      # fallback). For literal characters, callers pass the char directly.
      def key_init(state, key)
        modifier_init(state[:modifiers]).merge(key: SPECIAL_KEY_NAMES[key] || key.to_s)
      end

      def modifier_init(active)
        {
          shiftKey: active.include?(:shift),
          ctrlKey:  active.include?(:control),
          altKey:   active.include?(:alt),
          metaKey:  active.include?(:meta)
        }
      end

      def insert_char(handle, state, char)
        # A real browser suppresses the character when ctrl / alt / meta
        # are held — that's a shortcut, not a literal keystroke. Without
        # this guard `Ctrl+B` types a literal "b" into the field before
        # the jstoolbar shortcut handler runs.
        suppress = state[:modifiers].intersect?(SUPPRESSING_MODIFIERS)
        splice_at_caret(state, char) unless suppress
        code = char.upcase.bytes.first || 0
        init = modifier_init(state[:modifiers]).merge(key: char)
        dispatch_key_event(handle, 'keydown',  code, **init)
        dispatch_key_event(handle, 'keypress', code, **init) unless suppress
        dispatch_key_event(handle, 'keyup',    code, **init)
      end

      def dispatch_key_event(handle, type, key_code, **init_extras)
        return unless @js && @listened_types.include?(type)
        js.call('__dispatchKeyFromRuby', handle, type.to_s, key_code, init_extras)
        settle
      end

      def evaluate_script(code, args = [])
        js.call('__evalScript', code, args.map { |a| marshal_script_arg(a) })
      end

      # Capybara's async-script contract: the last `arguments[N]` is a
      # callback the script invokes with the resolved value. We start
      # the script, drain the virtual clock so any setTimeout-driven
      # work runs, then read whatever the callback received.
      def evaluate_async_script(code, args = [])
        marshalled = args.map { |a| marshal_script_arg(a) }
        js.call('__evalAsyncScript', code, marshalled)
        # Push virtual time forward enough for setTimeout-based callbacks
        # — there's no outer Capybara polling to advance the clock here.
        js.drain_timers(SYNC_DRAIN_MS) if @timers_active
        settle
        result = js.call('__pollAsyncResult')
        raise 'evaluate_async_script: callback was not invoked within virtual time' if result.nil?
        result['value']
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
        return true unless handle
        # Skip the ancestor walk when an addEventListener / observer
        # already qualifies the event for dispatch. Inline-handler
        # detection only matters as a fallback that also boots @js for
        # script-less pages (e.g. plain `onclick="..."` markup).
        listened = @listened_types.include?(type) || @mutation_recording
        return true unless listened || inline_handler_in_path?(handle, type)
        result = js.call('__dispatchFromRuby', handle, type.to_s,
                         {bubbles: bubbles, cancelable: cancelable, **init_extras})
        settle
        result
      end

      # Cheap pre-check so the JS bridge stays cold for events nobody
      # listens to. Walks the bubble path looking for an `on<type>` HTML
      # attribute — the inline-handler counterpart to addEventListener.
      def inline_handler_in_path?(handle, type)
        attr = "on#{type}"
        each_ancestor(lookup_node(handle)) { |cur| return true if cur[attr] }
        false
      end

      # mousedown → sleep(delay) → mouseup. JS handlers that read
      # Date.now() between the two events see real wall-clock elapsed,
      # which is what Selenium drivers also do for `click(delay:)`.
      def right_click(handle, modifiers = nil, delay: 0)
        mods = modifier_init(modifiers)
        fire_mouse_sequence(handle, button: 2, delay: delay, modifiers: mods)
        dispatch_event(handle, 'contextmenu', **mouse_init(button: 2), **mods)
        true
      end

      def double_click(handle, modifiers = nil, delay: 0)
        mods = modifier_init(modifiers)
        fire_mouse_sequence(handle, button: 0, delay: delay, modifiers: mods)
        init = mouse_init(button: 0)
        dispatch_event(handle, 'click',    **init, **mods)
        dispatch_event(handle, 'click',    **init, **mods)
        dispatch_event(handle, 'dblclick', **init, **mods)
        true
      end

      # Mouse-enter / mouse-leave a node. Real browsers fire
      # mouseleave on the previously-hovered element, then mouseenter
      # on the new one (both bubble-less); mouseover / mouseout bubble.
      # We track @hovered_handle to drive the leave-on-previous half so
      # tooltip-dismissal idioms like `find('body').hover` fire the
      # mouseleave on the prior tooltip target.
      def hover(handle)
        node = lookup_node(handle)
        return false if node.nil?
        return true  if @hovered_handle == handle
        if @hovered_handle
          dispatch_event(@hovered_handle, 'mouseout',   bubbles: true,  cancelable: true)
          dispatch_event(@hovered_handle, 'mouseleave', bubbles: false, cancelable: true)
        end
        @hovered_handle = handle
        dispatch_event(handle, 'mouseover',  bubbles: true,  cancelable: true)
        dispatch_event(handle, 'mouseenter', bubbles: false, cancelable: true)
        dispatch_event(handle, 'mousemove',  bubbles: true,  cancelable: true)
        true
      end

      def fire_mouse_sequence(handle, button:, delay:, modifiers:)
        init = mouse_init(button: button)
        dispatch_event(handle, 'mousedown', **init, **modifiers)
        sleep(delay) if delay && delay > 0
        dispatch_event(handle, 'mouseup',   **init, **modifiers)
      end

      # MouseEvent init slice. `event.which` is the 1-indexed mirror of
      # `event.button` (left=1, middle=2, right=3); pre-WHATWG code
      # (Redmine's `contextMenuClick` checks `event.which == 1`) reads
      # `which`, so emit both.
      def mouse_init(button:)
        {button: button, which: button + 1}
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
      # the JS side flips @mutation_recording via __notifyMutationActive,
      # so dom_op writes pay nothing on observer-less pages. Split into
      # two specialised methods (instead of one `**extra`) to skip the
      # kwargs hash + per-key empty-array allocations on the hot path.
      EMPTY_HANDLES = [].freeze

      def record_childlist(target_handle, added = EMPTY_HANDLES, removed = EMPTY_HANDLES)
        return unless @mutation_recording && target_handle
        @mutations << {type: 'childList', target: target_handle, addedNodes: added, removedNodes: removed}
      end

      def record_attribute(target_handle, name, old_value)
        return unless @mutation_recording && target_handle
        @mutations << {type: 'attributes', target: target_handle, attributeName: name, oldValue: old_value}
      end

      # Drain microtasks + scheduled timers (setTimeout(0), rAF) and
      # deliver pending mutations. Default drain advances virtual time
      # by SETTLE_DRAIN_MS — enough to fire requestAnimationFrame
      # callbacks (Turbo's `Visit#render` awaits one before swapping
      # the body, so omitting this leaves form-submission renders
      # stuck). Inside `accept_alert do ... end` we widen further so
      # `setTimeout(N) → alert(...)` reaches the modal handler — there
      # is no Capybara polling around that block to walk virtual time.
      SETTLE_DRAIN_MS = 32
      def settle
        return unless @js
        drain_max = @modal_handlers.empty? ? SETTLE_DRAIN_MS : SYNC_DRAIN_MS
        10.times do
          js.drain_timers(drain_max) if @timers_active
          break if @mutations.empty?
          records, @mutations = @mutations, []
          js.call('__deliverMutations', records)
        end
        @last_tick_ts  = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_until = nil
      end

      # Sticky polling decision: stay true for `POLLING_GRACE_S` after
      # timers fire so a setTimeout firing mid-loop doesn't drop the
      # synchronize block before Capybara's own `default_max_wait_time`
      # expires. Capybara's timer caps the actual wait, this is just an
      # upper bound on how long we lie about there being more work.
      POLLING_GRACE_S = 10
      def polling?
        now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        if @timers_active
          @polling_until = now + POLLING_GRACE_S
          true
        elsif @polling_until && now < @polling_until
          true
        else
          @polling_until = nil
          false
        end
      end

      SYNC_DRAIN_MS = 5_000

      # Advance the virtual JS clock by however much wall-clock time
      # has actually passed since the last tick. The cap stops a
      # runaway interval from looping forever in a single tick.
      TICK_CAP_MS = 5_000
      def tick_real_time
        return unless @js && @timers_active
        now      = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        elapsed  = ((now - @last_tick_ts) * 1000).to_i
        @last_tick_ts = now
        return if elapsed <= 0
        js.drain_timers([elapsed, TICK_CAP_MS].min)
      end

      # Single dispatch entry called from JS via `__dom(handle, op, args)`.
      def dom_op(handle, op, args)
        node = lookup_node(handle) || @document
        case op
        when 'querySelector'
          @handles.track(safe_at_css(node, args[0]))
        when 'querySelectorAll'
          safe_css(node, args[0]).map { |n| @handles.track(n) }
        when 'getElementById'
          # CSS rather than `.//*[@id=...]` because the XPath form
          # skips direct children of a DocumentFragment, which would
          # break shadow-root lookups.
          scope = node.respond_to?(:at_css) ? node : @document
          @handles.track(scope.at_css("##{escape_id_selector(args[0].to_s)}"))
        when 'closest'
          cur = node
          while cur && cur.element?
            return @handles.track(cur) if safe_matches?(cur, args[0])
            cur = cur.parent
          end
          nil
        when 'matches'
          node.element? && safe_matches?(node, args[0])
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
        when 'firstElementChild' then @handles.track(node.respond_to?(:element_children) ? node.element_children.first : nil)
        when 'lastElementChild'  then @handles.track(node.respond_to?(:element_children) ? node.element_children.last  : nil)
        when 'nextElementSibling'
          cur = node.next
          cur = cur.next while cur && !cur.element?
          @handles.track(cur)
        when 'previousElementSibling'
          cur = node.previous
          cur = cur.previous while cur && !cur.element?
          @handles.track(cur)
        when 'childElementCount' then node.respond_to?(:element_children) ? node.element_children.size : 0
        when 'nodeType'        then node_type_for(node)
        when 'nodeName'
          # DOM Node#nodeName: '#text' for text nodes, '#comment' for
          # comments, '#document-fragment' for fragments — uppercase
          # the name only for actual elements.
          name = node.name || ''
          if node.respond_to?(:type)
            case node.type
            when Nokogiri::XML::Node::TEXT_NODE                        then '#text'
            when Nokogiri::XML::Node::COMMENT_NODE                     then '#comment'
            when Nokogiri::XML::Node::CDATA_SECTION_NODE               then '#cdata-section'
            when Nokogiri::XML::Node::DOCUMENT_FRAG_NODE               then '#document-fragment'
            when Nokogiri::XML::Node::DOCUMENT_NODE, Nokogiri::XML::Node::HTML_DOCUMENT_NODE
              '#document'
            else name.upcase
            end
          else
            name.upcase
          end
        when 'tagName'         then (node.element? ? node.name.upcase : '')
        when 'textContent'     then node.text
        when 'innerText'       then visible_text(handle).strip
        when 'innerHTML'       then node.respond_to?(:inner_html) ? node.inner_html : node.to_html
        when 'outerHTML'       then node.to_html
        when 'getAttribute'    then node.respond_to?(:[]) ? node[args[0]] : nil
        when 'hasAttribute'    then node.respond_to?(:[]) ? !node[args[0]].nil? : false
        when 'attributes'
          (node.respond_to?(:attributes) ? node.attributes : {})
            .map { |k, v| [k, v.respond_to?(:value) ? v.value : v.to_s] }
        when 'value'           then value(handle)
        when 'checked'         then checked?(handle)
        when 'selected'        then !!(node.respond_to?(:[]) && node['selected'])
        when 'selectedIndex'
          # First option flagged `selected`, falling back to -1 — single
          # Ruby walk instead of one dom_op per option from the JS side.
          opts  = node.respond_to?(:css) ? node.css('option') : []
          found = opts.index {|o| o['selected'] }
          found || -1
        when 'disabled'        then !!(node.respond_to?(:[]) && node['disabled'])
        when 'hidden'          then !!(node.respond_to?(:[]) && node['hidden'])
        when 'form'            then @handles.track(enclosing_form(node))
        when 'list'
          list_id = node.respond_to?(:[]) && node['list']
          list_id ? @handles.track(@document.at_xpath('.//datalist[@id=$id]', nil, id: list_id.to_s)) : nil
        when 'options'
          (node.respond_to?(:css) ? node.css('option') : []).map { |n| @handles.track(n) }
        when 'label'
          node.respond_to?(:[]) ? (node['label'] || node.text) : ''
        when 'validity'           then compute_validity(node)
        when 'validationMessage'  then validation_message(node)
        when 'focus' then focus(handle); nil
        when 'blur'  then blur(handle);  nil
        when 'click' then click(handle); nil
        when 'submitForm' then submit_form(handle); nil
        when 'setAttribute'   then write_attribute(node, handle, args[0], args[1].to_s)
        when 'removeAttribute' then write_attribute(node, handle, args[0], nil)
        when 'setValue'
          # `el.value=` on a checkbox/radio writes the value attribute;
          # `.checked=` toggles state via setChecked.
          if node.name == 'input' && CHECKABLE_INPUT_TYPES.include?((node['type'] || '').downcase)
            write_attribute(node, handle, 'value', args[0].to_s)
          else
            set_value(handle, args[0])
            nil
          end
        when 'setChecked'      then set_value(handle, !!args[0]); nil
        when 'setOptionSelected'
          # IDL `option.selected = true` on a single-select clears the
          # previously-selected sibling. Mirrors what `select_option`
          # already does via the Capybara user-action path; keeps the
          # attribute as the literal `selected="selected"` Redmine reads.
          set_option_selected(node, !!args[0])
          nil
        when 'setSelectedIndex'
          # `select.selectedIndex = N` — flip the Nth option's `selected`
          # attribute on, clear the others. One Ruby pass instead of N
          # `setOptionSelected` round-trips that would each re-walk the
          # options list to clear siblings.
          if node.respond_to?(:css)
            idx = args[0].to_i
            node.css('option').each_with_index do |o, i|
              i == idx ? (o['selected'] = 'selected') : o.delete('selected')
            end
          end
          nil
        when 'setTextContent'
          node.content = args[0].to_s if node.respond_to?(:content=)
          record_childlist(handle)
          nil
        when 'setInnerHTML'
          node.inner_html = args[0].to_s if node.respond_to?(:inner_html=)
          record_childlist(handle)
          nil
        when 'setOuterHTML'
          # Mutation reported against the parent so subtree observers see the new nodes.
          parent = node.parent
          if parent
            fragment      = Nokogiri::HTML5.fragment(args[0].to_s)
            added_handles = fragment.children.map {|n| @handles.track(n) }
            node.replace(fragment)
            record_childlist(@handles.track(parent), added_handles, [handle])
          end
          nil
        when 'appendChild'
          child = lookup_node(args[0])
          if child && node.respond_to?(:add_child)
            # DocumentFragment unwraps on insertion (the fragment ends
            # up empty, its children move to `node`). Capture the
            # children-to-be-inserted before add_child drains them so
            # we can both record MutationObserver addedNodes and walk
            # the right subtree for inserted <script> execution.
            inserted_kids = child.is_a?(Nokogiri::XML::DocumentFragment) ? child.children.to_a : [child]
            node.add_child(child)
            added = inserted_kids.map {|c| @handles.track(c) }
            record_childlist(handle, added)
            inserted_kids.each {|n| run_inserted_scripts(n) }
          end
          args[0]
        when 'appendChildrenOf'
          # DocumentFragment append semantics: drain children of the
          # source into `node`. Used by template.content insertions —
          # the fragment "view" wraps a template handle, but appending
          # the fragment must move only its children, not the template.
          source = lookup_node(args[0])
          if source && node.respond_to?(:add_child)
            added = []
            source.children.to_a.each do |c|
              c.unlink
              node.add_child(c)
              added << @handles.track(c)
            end
            record_childlist(handle, added)
          end
          nil
        when 'insertChildrenOfBefore'
          source = lookup_node(args[0])
          ref    = lookup_node(args[1])
          if source
            added = []
            source.children.to_a.each do |c|
              c.unlink
              if ref then ref.add_previous_sibling(c) else node.add_child(c) end
              added << @handles.track(c)
            end
            record_childlist(handle, added)
          end
          nil
        when 'removeChild'
          child = lookup_node(args[0])
          if child && child.parent
            parent_handle = @handles.track(child.parent)
            child.unlink
            record_childlist(parent_handle, EMPTY_HANDLES, [args[0]])
          end
          args[0]
        when 'insertBefore'
          new_child = lookup_node(args[0])
          ref_child = lookup_node(args[1])
          if new_child
            inserted_kids = new_child.is_a?(Nokogiri::XML::DocumentFragment) ? new_child.children.to_a : [new_child]
            ref_child ? ref_child.add_previous_sibling(new_child) : node.add_child(new_child)
            added = inserted_kids.map {|c| @handles.track(c) }
            record_childlist(handle, added)
            inserted_kids.each {|n| run_inserted_scripts(n) }
          end
          args[0]
        when 'replaceChild'
          new_child = lookup_node(args[0])
          old_child = lookup_node(args[1])
          if new_child && old_child
            old_child.replace(new_child)
            record_childlist(handle, [args[0]], [args[1]])
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
        when 'attachShadow'
          # `host.attachShadow({mode: 'open'})` — set up a shadow tree
          # rooted at this host. Re-attach is illegal per spec; mirror
          # by returning the existing root if one is already present.
          existing = @shadow_roots[handle]
          if existing
            @handles.track(existing)
          else
            root = Nokogiri::HTML5::DocumentFragment.parse('')
            @shadow_roots[handle] = root
            @shadow_root_set << root
            @handles.track(root)
          end
        when 'shadowRoot'
          root = @shadow_roots[handle]
          root && @handles.track(root)
        when 'getElementsByTagName'
          # Always scoped to the receiver. `*` matches every descendant
          # element; jQuery's `getAll(elem, false)` relies on this for
          # `cleanData` and `empty()` not to chew through the document.
          tag = args[0].to_s.downcase
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
        when 'isEqualNode'
          other = lookup_node(args[0])
          # Structural equality via libxml2's serialised form. Cheap,
          # not spec-perfect (won't catch namespace differences) but
          # matches what Turbo's tracked-element check needs.
          !!(other && node.respond_to?(:to_html) && other.respond_to?(:to_html) && node.to_html == other.to_html)
        when 'cloneRangeContents'
          # JS-side `range.cloneContents()`. Build a fresh fragment in
          # the live document and walk from (startContainer, startOffset)
          # to (endContainer, endOffset) in tree order, partial-cloning
          # text-node boundaries and full-cloning interior siblings.
          start_node = lookup_node(args[0])
          end_node   = lookup_node(args[2])
          fragment   = Nokogiri::XML::DocumentFragment.new(@document)
          if start_node && end_node
            clone_range_into(fragment, start_node, args[1].to_i, end_node, args[3].to_i)
          end
          @handles.track(fragment)
        when 'parseHTML5Document'
          # DOMParser support: parse a full HTML5 document into a
          # standalone Nokogiri tree, register its nodes, and return
          # handles for the spec-shaped accessors. Nodes round-trip
          # through `insertBefore` etc. to land in the live document
          # (Nokogiri's `add_*_sibling` works across docs).
          parsed = Nokogiri::HTML5(args[0].to_s)
          html_node = parsed.at_xpath('/html')
          head_node = parsed.at_xpath('/html/head')
          body_node = parsed.at_xpath('/html/body')
          {
            'documentElement' => html_node && @handles.track(html_node),
            'head'            => head_node && @handles.track(head_node),
            'body'            => body_node && @handles.track(body_node)
          }
        else
          warn "[capybara-simulated] unsupported dom op: #{op}" if ENV['CSIM_DEBUG']
          nil
        end
      end


      def lookup_node(handle)
        handle && @handles.lookup(handle)
      end

      # Nokogiri's Node#path returns an absolute XPath that re-locates
      # the same node, e.g. /html[1]/body[1]/div[2]/a[3]. Nodes in a
      # shadow tree have no document-rooted XPath — match Selenium's
      # placeholder so callers see the same string they would there.
      SHADOW_PATH = '(: Shadow DOM element - no XPath :)'
      def node_path(handle)
        node = lookup_node(handle)
        return '' if node.nil?
        each_ancestor(node) { |a| return SHADOW_PATH if @shadow_root_set.include?(a) }
        node.path.to_s
      end

      def shadow_root_handle(host_handle)
        root = @shadow_roots[host_handle]
        root && @handles.track(root)
      end

      # Detached-from-document detection so Capybara's automatic-reload
      # kicks in. Two failure modes exist: the node was removed (handle
      # gone or the surviving Nokogiri object's ancestors no longer
      # include @document), or the integer handle was reused after a
      # reload and now points at a different live node — `captured`
      # lets the caller pin the original ref so we can spot the rebind.
      def stale?(handle, captured = nil)
        node = lookup_node(handle)
        return true if node.nil?
        return true if captured && !node.equal?(captured)
        return false if node.is_a?(Nokogiri::XML::Document) || @shadow_root_set.include?(node)
        # Walk parents without materialising an ancestors array — this
        # is the hot path (every Node accessor's check_stale).
        cur = node.respond_to?(:parent) ? node.parent : nil
        while cur
          return false if cur.equal?(@document) || @shadow_root_set.include?(cur)
          cur = cur.respond_to?(:parent) ? cur.parent : nil
        end
        true
      end

      # No tick_real_time: stale-checking is a pure parent-chain walk
      # and runs on every Node accessor. Draining timers here would
      # keep advancing virtual time mid-assertion. User-action paths
      # (click / fill_in / visit) tick separately.
      def check_stale(handle, captured = nil)
        raise StaleElement, 'element is no longer attached to the document' if stale?(handle, captured)
      end

      # Push a one-shot handler onto the stack — the next modal that
      # fires consumes the topmost handler. Nested with_modal calls
      # therefore pair up with sequential dialogs in dispatch order
      # (innermost handler matches the first dialog, etc.). Pulled off
      # again on block exit in case the dialog never fired.
      def with_modal(handler)
        @modal_handlers.push(handler)
        yield
      ensure
        @modal_handlers.delete(handler)
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
        handler = @modal_handlers.pop
        if handler
          handler.call(type, message, default_value)
        else
          # No handler — accept, matching v1 / Rails system-test defaults
          # so Turbo's `data-turbo-confirm` proceeds when the test
          # doesn't explicitly dismiss.
          case type
          when 'alert'   then nil
          when 'confirm' then true
          when 'prompt'  then default_value.to_s
          end
        end
      end

      private

      def navigate(method, url, body: nil, content_type: nil, referer: @current_url)
        req = Request.new(method: method, url: url, body: body, content_type: content_type, referer: referer)
        # Discard forward history — a real browser drops the redo stack
        # the moment you navigate after a `go_back`. Skip the reslice
        # when we're already at the tail (the common case).
        @history = @history[0..@history_idx] if @history_idx < @history.size - 1
        @history << req
        @history_idx = @history.size - 1
        replay(req)
      end

      def current_request = @history[@history_idx]

      def replay(req)
        status, headers, response_body = rack_request(
          method:       req.method,
          url:          req.url,
          body:         req.body,
          content_type: req.content_type,
          referer:      req.referer
        )

        if (loc = redirect_location(status, headers))
          # Browsers carry the request's fragment through redirects when
          # the redirect Location doesn't itself have one (RFC 7231 §7.1.2).
          preserve = status == 307 || status == 308
          target   = resolve(loc, base: req.url)
          fragment = URI.parse(req.url).fragment
          target   = "#{target}##{fragment}" if fragment && !target.include?('#')
          return replay(Request.new(
            method:       preserve ? req.method : :get,
            url:          target,
            body:         preserve ? req.body : nil,
            content_type: preserve ? req.content_type : nil,
            referer:      req.referer
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
        @hovered_handle = nil
        @document    = Nokogiri::HTML5(response_body)
        @handles.reset!(@document)
        # Run inline `<script>` tags only when the page actually has any —
        # avoids paying QuickJS cold-start on rack_test-style flows. Reset
        # the virtual clock so timers from the previous page can't fire on
        # this one, and drain afterwards to settle initial setTimeout(0)s.
        if @document.at_css('script')
          bootstrap_page
        elsif @js
          @js.reset_page
          reset_per_page_state
          @last_tick_ts = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        end
        status
      end

      # Re-runs `<script>` tags + lifecycle events. Called on every page
      # load AND after a JsRuntime VM recycle so the fresh VM ends up
      # with the same handler / library state the previous one had.
      def bootstrap_page
        return unless @document.at_css('script')
        # Order matters: reset Ruby-side listener trackers BEFORE
        # `js.reset_page` re-arms the CE registry. The re-arm walks
        # existing custom elements and runs their connectedCallback —
        # for Turbo's <turbo-frame>, that fires
        # FormSubmitObserver.start which calls addEventListener →
        # bumpListenerCount → __setListenedType. If we cleared
        # @listened_types AFTER that, those re-registrations would be
        # nuked and dispatch_event would early-out for those types.
        reset_per_page_state
        js.reset_page
        # Must precede run_scripts: Turbo's start() seeds history from window.location.href.
        js.call('__syncLocation', @current_url.to_s) if @current_url
        ingest_importmaps
        js.run_scripts(self, @document)
        fire_lifecycle_events
        settle
      end

      def empty_importmap = {'imports' => {}, 'scopes' => {}}

      # Per HTML spec only the first importmap wins, but importmap-rails
      # can ship multi-pin output as separate tags — later maps just
      # override earlier keys, matching that.
      def ingest_importmaps
        @document.css('script[type="importmap"]').each do |tag|
          src = importmap_source(tag)
          next if src.nil? || src.empty?
          parsed = JSON.parse(src) rescue nil
          next unless parsed.is_a?(Hash)
          @importmap['imports'].merge!(parsed['imports']) if parsed['imports'].is_a?(Hash)
          @importmap['scopes'].merge!(parsed['scopes'])   if parsed['scopes'].is_a?(Hash)
        end
      end

      def importmap_source(tag)
        return tag.text if tag['src'].nil? || tag['src'].empty?
        fetch_resource(resolve(tag['src']))
      end

      # quickjs.rb's module-loader callback. The URL was already made
      # absolute on a prior rewrite pass, so we just fetch + rewrite +
      # cache.
      def load_module(url)
        # `import(path)` with a non-literal specifier (stimulus-loading's
        # eager loader) bypasses the static rewrite, so the loader needs
        # to consult the importmap itself.
        url = resolve_module_specifier(url, @current_url || DEFAULT_HOST)
        @module_cache[url] ||= begin
          body = rack_get(url)
          body.nil? ? nil : rewrite_module_imports(body, url)
        end
      end

      # Inline modules have no URL, but the loader keys by URL.
      # Synthesise a deterministic one so a re-evaluated body (after
      # VM recycle) hits the cached rewrite.
      def cache_inline_module(url, source)
        @module_cache[url] ||= rewrite_module_imports(source, @current_url || url)
        url
      end

      # HTML module-script resolution: bare specifiers via importmap,
      # everything else URL-relative to the importer.
      def resolve_module_specifier(specifier, base_url)
        if (mapped = @importmap['imports'][specifier])
          return resolve(mapped, base: base_url)
        end
        if specifier.start_with?('/', './', '../') || specifier.match?(%r{\A[a-z]+://}i)
          return resolve(specifier, base: base_url)
        end
        # Bare specifier with no importmap entry — pass through so the
        # loader surfaces a useful error.
        specifier
      end

      # The leading anchor (start of line OR non-identifier char) keeps
      # `import`/`export` substrings inside words from matching.
      # Template-literal specifiers (`import \`./${x}.js\``) aren't
      # handled and aren't valid static-import syntax anyway.
      MODULE_IMPORT_RE = %r{
        (?<lead>(?:^|[^\w$.]))
        (?:
          (?<static>(?:import|export)(?:\s+(?:[\w*${},\s]+)\s+from)?\s*) (?<q1>['"])(?<spec1>[^'"\n]+)\k<q1>
          |
          (?<dynamic>import\s*\(\s*) (?<q2>['"])(?<spec2>[^'"\n]+)\k<q2>
        )
      }x.freeze

      def rewrite_module_imports(source, base_url)
        source.gsub(MODULE_IMPORT_RE) do
          m        = Regexp.last_match
          spec     = m[:spec1] || m[:spec2]
          quote    = m[:q1]    || m[:q2]
          resolved = resolve_module_specifier(spec, base_url)
          prefix   = m[:static] || m[:dynamic]
          "#{m[:lead]}#{prefix}#{quote}#{resolved}#{quote}"
        end
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
        status, _headers, body = rack_request(method: :get, url: url)
        return body if (200..299).cover?(status)
        warn "[capybara-simulated] script src #{url} returned #{status}" if ENV['CSIM_DEBUG']
        nil
      end

      # window.fetch entry point. Routes through Rack like rack_get /
      # replay but doesn't touch @current_url / @document — `fetch` is
      # a data round-trip, not navigation. Follows redirects internally
      # so `Response.redirected` is meaningful.
      MAX_FETCH_REDIRECTS = 20
      def rack_fetch(method, url, body, headers, redirect_mode)
        target     = resolve(url.to_s)
        method     = (method || 'GET').to_s.upcase
        redirected = false
        MAX_FETCH_REDIRECTS.times do
          status, response_headers, response_body = rack_request(
            method:  method,
            url:     target,
            body:    body,
            headers: headers,
            referer: @current_url
          )

          if redirect_mode != 'manual' && (loc = redirect_location(status, response_headers))
            raise StandardError, '[capybara-simulated] fetch: redirect blocked by redirect=error mode' if redirect_mode == 'error'
            redirected = true
            preserve   = status == 307 || status == 308
            target     = resolve(loc, base: target)
            method     = 'GET' unless preserve
            body       = nil   unless preserve
            next
          end

          return {
            'status'     => status,
            'headers'    => response_headers.flat_map { |k, v| Array(v).map { |val| [k.to_s, val.to_s] } },
            'body'       => response_body,
            'url'        => target,
            'redirected' => redirected,
            'type'       => 'basic'
          }
        end
        raise StandardError, "[capybara-simulated] fetch exceeded #{MAX_FETCH_REDIRECTS} redirects"
      end

      # Single-shot Rack call. Builds env from cookies / referer / body /
      # headers, ingests Set-Cookie on the response, returns the parsed
      # body alongside status + headers. Doesn't follow redirects —
      # callers do that with `redirect_location` (replay recurses,
      # rack_fetch loops).
      def rack_request(method:, url:, body: nil, content_type: nil, headers: nil, referer: nil)
        opts = {method: method.to_s.upcase}
        opts[:input]         = body                  if body
        opts['CONTENT_TYPE'] = content_type          if content_type
        opts['HTTP_COOKIE']  = cookie_header_value   unless @cookies.empty?
        opts['HTTP_REFERER'] = referer               if referer
        merge_request_headers(opts, headers)
        # env_for accepts an absolute URL and derives HTTP_HOST /
        # SERVER_NAME / SERVER_PORT / rack.url_scheme from it.
        env = Rack::MockRequest.env_for(url, **opts)
        status, response_headers, body_iter = @app.call(env)
        response_body = read_rack_body(body_iter)
        ingest_set_cookie(response_headers)
        [status, response_headers, response_body]
      end

      # Merge JS-side fetch headers into a Rack env-shaped opts hash.
      # CONTENT_TYPE / CONTENT_LENGTH aren't HTTP_-prefixed in env_for.
      def merge_request_headers(opts, headers)
        return unless headers
        headers.each do |k, v|
          case k.to_s.downcase
          when 'content-type'   then opts['CONTENT_TYPE']   = v.to_s
          when 'content-length' then opts['CONTENT_LENGTH'] = v.to_s
          else opts["HTTP_#{k.to_s.upcase.tr('-', '_')}"] = v.to_s
          end
        end
      end

      # Case-insensitive header lookup. Rack-3 apps return lowercase keys
      # but rack_test / test harnesses still hand back classic-cased
      # headers, so we accept both.
      def header_value(headers, name)
        headers[name.downcase] || headers[name]
      end

      def redirect_location(status, headers)
        return nil unless (300..399).cover?(status)
        loc = header_value(headers, 'Location')
        loc unless loc.nil? || loc.empty?
      end

      def read_rack_body(iter)
        return '' unless iter.respond_to?(:each)
        body = +''
        iter.each { |c| body << c.to_s }
        iter.close if iter.respond_to?(:close)
        body
      end

      def fire_lifecycle_events
        return unless @js
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

      # We don't honour Path / Domain / Expires — single-session,
      # single-domain cookie jar matches what rack_test does.
      def ingest_set_cookie(headers)
        raw = header_value(headers, 'Set-Cookie')
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
          # Stored attributes are the source of truth in this driver — we don't track
          # an in-memory defaultValue snapshot, so reset is a no-op.
          true
        when 'checkbox', 'radio'
          # Toggle already happened in pretoggle_form_control; nothing
          # more to do once the click event passed through.
          true
        else
          false
        end
      end

      # Toggle a checkbox / radio before the click event so listeners see
      # the post-toggle state, returning the prior value so the caller
      # can revert if a listener preventDefault'd. Non-toggleable nodes
      # return nil (no revert needed).
      def pretoggle_form_control(node)
        return nil unless node.respond_to?(:name) && node.name == 'input'
        type = (node['type'] || '').downcase
        case type
        when 'checkbox'
          prior = !!node['checked']
          set_value(@handles.track(node), !prior)
          prior
        when 'radio'
          prior = !!node['checked']
          set_value(@handles.track(node), true)
          prior
        end
      end

      # No-op when `prior_checked` is nil — `pretoggle_form_control`
      # returns nil for non-toggleable nodes, so the click path can
      # always call this without guarding.
      def revert_pretoggle(node, prior_checked)
        return if prior_checked.nil?
        set_value(@handles.track(node), prior_checked)
      end

      def submit(form, submitter)
        form_handle = @handles.track(form)
        # Capture submitter name / value / formaction up front: rails-ujs's
        # `data-disable-with` listener disables the submit button while
        # dispatch is in flight, which would drop the submitter row from
        # `serialize_form` afterwards. The other side of the coin —
        # Redmine's settings form has a submit listener that
        # `prop('selected', true)`'s every option of its dual-listbox
        # `<select multiple>`s — wants the *post-listener* form state.
        # Serialize once after dispatch and patch the submitter row
        # back in if the listener disabled it.
        submitter_name        = submitter && submitter['name']
        submitter_value       = submitter && submitter['value'].to_s
        method_attr = (submitter && submitter['formmethod']) || form['method'] || 'get'
        action_attr = (submitter && submitter['formaction']) || form['action']
        method      = method_attr.to_s.downcase
        action      = resolve(action_attr.to_s.empty? ? @current_url.to_s : action_attr.to_s)
        # `event.submitter` lets Turbo's FormSubmitObserver honour
        # `data-turbo="false"` on the clicked button — without it Turbo
        # treats every form-inside-a-frame submission as navigatable
        # and intercepts it.
        return true unless dispatch_event(form_handle, 'submit', submitter: @handles.track(submitter))
        if method == 'post' && multipart_form?(form)
          content_type, body = build_multipart(form, submitter)
        else
          rows = serialize_form(form, submitter)
          # If the listener disabled the submit button, our serializer
          # skipped it — patch the captured submitter row back in.
          if submitter_name && !submitter_name.empty? && !rows.any? { |k, _| k == submitter_name }
            rows << [submitter_name, submitter_value]
          end
          content_type = (method == 'post') ? 'application/x-www-form-urlencoded' : nil
          body         = URI.encode_www_form(rows)
        end
        if method == 'post'
          navigate(:post, action, body: body, content_type: content_type)
        else
          uri = URI.parse(action)
          uri.query = body
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
      ADOPTED_FIELD_XPATH = '//*[(self::input or self::textarea or ' \
                            "self::select or self::button) and @form=$fid]".freeze

      def each_form_field(form, submitter)
        form_id      = form['id']
        descendants  = form.css(FORM_FIELD_CSS)
        adopted      = if form_id && !form_id.empty?
          @document.xpath(ADOPTED_FIELD_XPATH, nil, fid: form_id.to_s).to_a
        else
          []
        end
        # Common case (no `form="<id>"` opt-ins on the page) skips the
        # merge / sort / uniq — descendants are already in doc order
        # from form.css. Otherwise sort via Nokogiri's Node#<=> which
        # is libxml2-backed (cheaper than building per-node n.path).
        associated = adopted.empty? ? descendants : (descendants.to_a + adopted).uniq.sort
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
        node.respond_to?(:ancestors) ? node.ancestors('form').first : nil
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
        value   = field_value(node)
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
      # turning visible_text from O(N×depth) into O(N). `transform`
      # carries inherited `text-transform` so descendant text picks up
      # uppercase / lowercase / capitalize from any ancestor.
      def collect_visible_text(node, out, root:, transform: nil)
        return if node.nil?
        if node.is_a?(Nokogiri::XML::Text)
          out << apply_text_transform(node.text.gsub(INLINE_WHITESPACE_RE, ' '), transform)
          return
        end
        return unless node.respond_to?(:children)
        return if INVISIBLE_TAGS.include?(node.name)
        if node.respond_to?(:[])
          return if root ? style_hidden?(node) : self_hidden?(node)
          transform = inherited_transform(transform, root ? ancestor_transform(node) : node_transform(node))
        end
        if node.name == 'br'
          out << "\n"
          return
        end
        # Real-browser innerText only inserts block boundaries around
        # blocks that actually emit text — collect children's output
        # into a scratch buffer so empty blocks collapse cleanly.
        if BLOCK_TAGS.include?(node.name)
          inner = String.new
          node.children.each { |c| collect_visible_text(c, inner, root: false, transform: transform) }
          return if inner.empty?
          out << "\n" unless out.empty? || out.end_with?("\n")
          out << inner
          out << "\n" unless out.end_with?("\n")
        else
          node.children.each { |c| collect_visible_text(c, out, root: false, transform: transform) }
        end
      end

      TEXT_TRANSFORM_RE = /text-transform\s*:\s*([a-z-]+)/i

      def node_transform(node)
        style = node['style']
        return nil if style.nil? || style.empty?
        m = style.match(TEXT_TRANSFORM_RE)
        m && m[1].downcase
      end

      def ancestor_transform(node)
        each_ancestor(node) do |cur|
          t = node_transform(cur)
          return t if t
        end
        nil
      end

      # `inherit` (and the implicit default) lets a parent's value flow
      # through; `none` resets back to no transform.
      def inherited_transform(parent_transform, own)
        return parent_transform if own.nil? || own == 'inherit'
        own
      end

      def apply_text_transform(str, transform)
        case transform
        when 'uppercase' then str.upcase
        when 'lowercase' then str.downcase
        when 'capitalize'
          str.gsub(/\b\w/) { |c| c.upcase }
        else str
        end
      end

      def self_hidden?(node)
        return true if node['hidden']
        style = node['style'].to_s
        style.match?(DISPLAY_NONE_RE) || style.match?(VISIBILITY_HIDDEN_RE)
      end

      DISPLAY_NONE_RE       = /display\s*:\s*none/i
      VISIBILITY_HIDDEN_RE  = /visibility\s*:\s*hidden/i

      def style_hidden?(node)
        each_ancestor(node) do |cur|
          return true if cur['hidden']
          style = cur['style'].to_s
          return true if style.match?(DISPLAY_NONE_RE)
          return true if style.match?(VISIBILITY_HIDDEN_RE)
        end
        false
      end

      # Methods JsRuntime reaches into directly. Re-publishing here
      # (after every method has been defined under `private`) keeps the
      # rest of the surface area private without splitting the file.
      public :fetch_resource, :resolve, :load_module, :cache_inline_module, :rack_fetch
    end
  end
end
