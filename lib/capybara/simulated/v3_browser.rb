# frozen_string_literal: true

# v3 PoC Browser. Standalone — does *not* inherit from the v2
# `Browser` because the whole point of v3 is to drop the Nokogiri
# tree and its accumulated machinery. Subset of `Browser`'s surface
# wired up so a `Capybara::Session` can `visit` and `find` against
# the V8-resident DOM. Milestones 3+ grow this incrementally.

require 'date'
require 'fileutils'
require 'json'
require 'nokogiri'
require 'rack/mock'
require 'uri'
require_relative 'errors'
require_relative 'esm_rewriter'
require_relative 'trace'
require_relative 'v3_runtime'

module Capybara
  module Simulated
    class V3Browser
      DEFAULT_HOST = 'http://www.example.com'

      attr_reader :app, :runtime
      attr_accessor :timers_active, :intersection_observer_active

      # Sticky window after timers finish: keep polling? true so a
      # setTimeout firing mid-loop doesn't drop Capybara's synchronize
      # block before its own `default_max_wait_time` kicks in.
      POLLING_GRACE_S = 10
      # Virtual clock advances on every find / has_?. Floor is 10 ms so
      # tests with `default_retry_interval = 0` still make progress
      # toward `setTimeout(N>0)` callbacks; cap is 5 s so a runaway
      # setInterval can't loop indefinitely in a single tick.
      TICK_MIN_MS = 10
      TICK_CAP_MS = 5_000

      def initialize(app)
        @app                          = app
        @runtime                      = V3Runtime.new(self)
        @current_url                  = nil
        @cookies                      = {}
        @local_storage                = {}
        @session_storage              = {}
        @sticky_headers               = {}
        @timers_active                = false
        @intersection_observer_active = false
        # Handle IDs are per-Context integer sequences: a handle from
        # a pre-rebuild context could collide with a fresh node's id
        # in the new context. V3Node captures this on construction;
        # `check_stale` rejects on mismatch.
        @context_gen                  = 0
        @find_cache_dirty             = true
        @find_cache_kind              = nil
        @find_cache_arg               = nil
        @find_cache_ctx               = nil
        @find_cache_value             = nil
        @document_handle              = 0
        @last_tick_ts                 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_until                = nil
        @ticking                      = false
        @history                      = []
        @history_idx                  = -1
        @modal_handlers               = []
        @module_cache                 = {}
        # Per-test action trace. `@trace` is the live recorder; `reset!`
        # moves it to `@pending_trace` so an after-hook running after
        # session reset still has access. `@trace_mode` is cached at
        # construction so `record_action`'s hot path doesn't pay an
        # ENV lookup.
        #
        # `CSIM_TRACE=off|on-failure|full` (default `on-failure`):
        # - `off`       — no recording at all; `record_action` early-exits.
        # - `on-failure` — record kind/url/console/network in-memory;
        #                  snapshot `dom_after` only on action error.
        # - `full`      — record + snapshot DOM after every action
        #                 (v2-equivalent; debug-heavy).
        # File output is orthogonal — `CSIM_TRACE_DIR=path` makes the
        # test-runner hook persist the trace JSON there; unset means
        # in-memory only (no files written without explicit opt-in).
        @trace            = nil
        @pending_trace    = nil
        @recording_action = false
        @trace_mode       = parse_trace_mode(ENV['CSIM_TRACE'])
        # ESM loading is on by default — Stimulus boots end-to-end with
        # the EventListener-object branch in `addEventListener`, and
        # `CSIM_V3_ESM=1`'s previous gating on a
        # `addFormObserversForDoubleSubmit` double-register no longer
        # reproduces (the snapshot path runs each library body once, so
        # the legacy ready chain only registers once). Set
        # `CSIM_V3_ESM=0` to opt out for diagnostic comparison.
        @esm_enabled = ENV['CSIM_V3_ESM'] != '0'
        apply_esm_flag
      end

      # Re-apply the `__csim_esm_enabled` global after a per-visit
      # context rebuild — the warm snapshot doesn't carry it and the
      # module-script branch in `runInlineScripts` reads it during
      # `__csimLoadDocument`, so the flag has to land before the doc
      # parse runs.
      def apply_esm_flag
        @runtime.call('__csimSetEsmEnabled', @esm_enabled)
      end

      # `console.*` short-circuits to a property read when this flag
      # is false (see `vendor/js/v3_bridge.js`). The flag is a JS-side
      # global, so it has to be re-applied after every `rebuild_ctx`
      # while a trace is live — without this, page scripts that run
      # during the per-visit `__csimLoadDocument` log to a stale
      # (false) flag and their console output is dropped from the
      # trace.
      def apply_trace_flag
        @runtime.call('__csimSetTraceActive', !@trace.nil?)
      end

      # The viewport size lives on the JS-side `globalThis.innerWidth`
      # / `globalThis.innerHeight` slots. Per-visit `rebuild_ctx` boots
      # a fresh Context from the snapshot (1024×768) so we have to
      # re-apply a resize made before the visit. Caller-level resizes
      # via `set_viewport` use the same setter directly.
      def apply_viewport
        return unless @viewport_width && @viewport_height
        @runtime.eval("globalThis.innerWidth = #{@viewport_width}; globalThis.innerHeight = #{@viewport_height};")
      end

      # ── Capybara DSL surface (just enough for milestone 2) ──────

      # Address-bar navigation: no Referer, and relative paths resolve
      # against the host root (not the current page's directory).
      def visit(url)
        navigate(resolve_visit_url(url), referer: nil)
      end

      def resolve_visit_url(url)
        s = url.to_s
        return s if s =~ %r{\A[a-z]+://}i
        require 'uri'
        host_root = (begin URI.parse(@current_url) rescue nil end)&.tap {|u| u.path = ''; u.query = nil; u.fragment = nil }&.to_s || DEFAULT_HOST
        host_root = host_root.sub(/\/+$/, '')
        s = "/#{s}" unless s.start_with?('/')
        "#{host_root}#{s}"
      end

      def current_url
        tick_real_time
        @current_url || ''
      end

      # Capybara routes plenty of compound CSS — `[type='submit']` /
      # pseudo classes / sibling combinators — through `find_css` even
      # when the resolved locator is XPath. The v3 JS selector parser
      # is intentionally minimal (tag / id / class / attr / descendant
      # / grouping). To get full Capybara coverage without growing
      # the JS parser, route through Nokogiri's CSS → XPath translator
      # and reuse `find_xpath`; the JS parser stays the fast path
      # for the simple selectors customElements / framework code
      # emits internally.
      # Dynamic pseudo-classes that depend on runtime state (focus,
      # interaction) instead of static DOM shape. Nokogiri's CSS-to-
      # XPath emits `nokogiri:focus(...)` for these, which wgxpath
      # can't evaluate (extension functions aren't registered),
      # silently returning empty. The JS-side parser DOES handle them,
      # so we shortcut around the XPath path entirely when we see one.
      DYNAMIC_PSEUDO_RE = /:(focus|focus-within|focus-visible|hover|active|checked|disabled|enabled|valid|invalid|required|optional|read-only|read-write|placeholder-shown|target)\b/

      def find_css(css, context_handle = nil)
        s = css.to_s
        if xpath_shaped?(s)
          return find_xpath(s, context_handle)
        end
        unless s.match?(DYNAMIC_PSEUDO_RE)
          begin
            # When scoped, emit context-relative XPath (`.//`) so wgxpath
            # honors the context node. Without the prefix Nokogiri returns
            # `//` (descendant-of-root) which ignores `context_handle` and
            # collects matches across the whole document — surfaced as
            # `Capybara::Ambiguous` whenever a within() block expected one
            # element (e.g. Redmine's ReactionsSystemTest scoped to a span).
            prefix = context_handle ? './/' : '//'
            xpaths = Nokogiri::CSS.xpath_for(s, prefix: prefix)
            unless xpaths.empty?
              # Comma groups emit one xpath each — union with ` | `.
              combined = xpaths.length == 1 ? xpaths.first : xpaths.join(' | ')
              return find_xpath(combined, context_handle)
            end
          rescue Nokogiri::CSS::SyntaxError, StandardError
            # Fall back to the JS-side parser. Worth trying because
            # `xpath_for` can choke on Capybara-emitted pseudo selectors
            # (`:not(...)`, attribute case-insensitive flags) that our
            # JS path either supports or ignores predictably.
          end
        end
        find_with_timer_fallback(:css, s, context_handle) do
          @runtime.call('__csimQuery', context_handle || @document_handle, s).to_a
        end
      end

      def find_first_css(css, context_handle = nil)
        s = css.to_s
        find_with_timer_fallback(:css_first, s, context_handle) do
          h = @runtime.call('__csimQueryOne', context_handle || @document_handle, s).to_i
          h.zero? ? nil : h
        end
      end

      def xpath_shaped?(s)
        # Cheap probe: anything starting with `/` (absolute or relative
        # XPath), `(` (grouped XPath like `(//a)[1]`), or `./` /
        # `..` (XPath current-node + step) is XPath. We can't treat a
        # bare leading `.` as XPath because CSS class selectors look
        # exactly like that (`.contextual`); only the `./` form is
        # unambiguous.
        !!(s =~ %r{\A\s*(?:/|\(\s*/|\./|\.\.)})
      end

      # XPath reverse-bridge (see V3_DESIGN.md "HTML parsing in v3"):
      # serialise the JS subtree with each Element's handle baked into a
      # `data-csim-handle` attribute, run libxml2's XPath on the parsed
      # HTML, recover JS handle ids from the attribute. One Context#call
      # plus one Nokogiri parse per query — still cheap vs v2's
      # per-element __dom callback storm.
      # XPath is evaluated *inside* V8 against the live JS DOM via
      # wgxpath (vendored, installed at snapshot build). One IPC per
      # `find_xpath` — no serialise + reparse round-trip. Set
      # `CSIM_V3_XPATH=nokogiri` to fall back to the serialize-and-
      # reparse path for debugging when wgxpath chokes on a query.
      XPATH_BACKEND = ENV['CSIM_V3_XPATH'] == 'nokogiri' ? :nokogiri : :wgxpath
      def find_xpath(xpath, context_handle = nil)
        xpath_str = xpath.to_s
        find_with_timer_fallback(:xpath, xpath_str, context_handle) do
          if XPATH_BACKEND == :nokogiri
            find_xpath_via_nokogiri(xpath, context_handle)
          else
            @runtime.call('__csimEvaluateXPath', xpath_str, context_handle || 0).to_a
          end
        end
      end

      def find_with_timer_fallback(kind, arg, ctx)
        tick_real_time if timer_wait_elapsed?
        result = cached_find(kind, arg, ctx) { yield }
        return result unless empty_find_result?(result) && @timers_active

        tick_real_time
        return result unless @find_cache_dirty

        cached_find(kind, arg, ctx) { yield }
      end

      def empty_find_result?(result)
        result.nil? || (result.respond_to?(:empty?) && result.empty?)
      end

      FIND_PRE_TICK_MIN_S = 0.05
      def timer_wait_elapsed?
        @timers_active &&
          (Process.clock_gettime(Process::CLOCK_MONOTONIC) - @last_tick_ts) >= FIND_PRE_TICK_MIN_S
      end

      # Single-slot cache for the most recent find_xpath / find_css /
      # find_first_css result. Capybara's `synchronize` retry loop
      # re-issues the same find on every poll while waiting for an
      # element to appear or disappear; if no DOM-mutating event has
      # happened since the last call (no timer fired, no click / set /
      # navigate), the result is guaranteed identical and we can skip
      # the V8 round-trip + wgxpath traversal.
      def cached_find(kind, arg, ctx)
        if !@find_cache_dirty &&
           @find_cache_kind == kind &&
           @find_cache_ctx  == ctx &&
           @find_cache_arg  == arg
          return @find_cache_value
        end
        result = yield
        @find_cache_kind  = kind
        @find_cache_arg   = arg
        @find_cache_ctx   = ctx
        @find_cache_value = result
        @find_cache_dirty = false
        result
      end

      # Any operation that may have mutated the DOM (click, set,
      # send_keys, navigate, hover, …) must call this so the next find
      # falls through to a fresh V8 query. Timer drains that fire any
      # callbacks also dirty (see `tick_real_time`).
      def invalidate_find_cache
        @find_cache_dirty = true
      end

      # Kept as a fallback / debug aid. Same semantics as the wgxpath
      # path but routes through Nokogiri::HTML5 — useful when wgxpath
      # rejects a query Capybara emits.
      def find_xpath_via_nokogiri(xpath, context_handle = nil)
        html = @runtime.call('__csimSerialize', 0).to_s
        return [] if html.empty?
        doc  = Nokogiri::HTML5.parse(html)
        root = context_handle ? doc.at_xpath("//*[@data-csim-handle='#{context_handle}']") : doc
        return [] unless root
        root.xpath(xpath.to_s).filter_map {|n|
          n.respond_to?(:[]) ? n['data-csim-handle']&.to_i : nil
        }.reject(&:zero?)
      end

      def text(handle)        = @runtime.call('__csimText', handle).to_s
      def tag(handle)         = @runtime.call('__csimTag', handle).to_s
      def attr(handle, name)  = @runtime.call('__csimAttr', handle, name.to_s)
      def file_input?(handle)
        tag(handle) == 'input' && attr(handle, 'type').to_s.downcase == 'file'
      end
      def visible?(handle)    = @runtime.call('__csimVisible', handle) ? true : false

      # Capybara::Driver::Node surface — V3Node calls `check_stale`
      # before each read, and that advances the virtual clock.
      def all_text(handle)     = text(handle)
      def visible_text(handle) = @runtime.call('__csimVisibleText', handle).to_s
      def tag_name(handle)     = tag(handle)
      def value(handle)        = @runtime.call('__csimValue', handle)
      def disabled?(handle)    = @runtime.call('__csimDisabled', handle)
      def option_selected?(h)  = !!attr(h, 'selected')
      def shadow_root_handle(handle)
        h = @runtime.call('__csimShadowRoot', handle).to_i
        h.zero? ? nil : h
      end
      def computed_style(handle, names)
        tick_real_time
        result = @runtime.call('__csimComputedStyle', handle, names.map(&:to_s))
        return names.to_h {|n| [n, ''] } unless result.is_a?(Hash)
        result.transform_keys(&:to_s)
      end
      def node_path(handle)    = @runtime.call('__csimNodePath', handle).to_s

      def lookup_node(handle)
        handle if @runtime.call('__csimAlive', handle)
      end

      def check_stale(handle, initial, gen = nil)
        return if initial && (gen.nil? || gen == @context_gen) && @runtime.call('__csimAlive', handle)

        tick_real_time
        return if initial && (gen.nil? || gen == @context_gen) && @runtime.call('__csimAlive', handle)

        raise Capybara::Simulated::StaleElement, "Element with handle #{handle} is no longer attached to the document"
      end

      # PoC click: anchors with href navigate; submit buttons trigger a
      # form submission through the Rack app. Checkbox / radio toggle
      # inline on the JS side (no Ruby trip). Everything else is a
      # no-op until milestone 4 lands event dispatch.
      def click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
        init = click_event_init(handle, keys, opts)
        delay = opts[:delay].to_f
        action =
          if delay > 0
            # Wall-sleep between mousedown and mouseup so click handlers
            # reading `Date.now()` see the elapsed gap (selenium parity).
            init['mouseDownOnly'] = true
            partial = @runtime.call('__csimClickResolve', handle, init)
            sleep delay
            @runtime.call('__csimClickFinish', handle, partial.is_a?(Hash) ? partial['base'] : init)
          else
            @runtime.call('__csimClickResolve', handle, init)
          end
        unless action.is_a?(Hash)
          tick_real_time
          return
        end
        case action['kind']
        when 'navigate'
          url = action['url'].to_s
          # In-page anchor links (`#frag` / current-page + `#frag`) move
          # the hash but don't fetch a new document. Pure-fragment also
          # short-circuits the `<a>`s test fixtures use as click sinks.
          if pure_fragment_navigation?(url)
            update_current_hash(url)
          else
            # Drain any work the click handler queued before the VM gets
            # rebuilt — analytics libraries (Ahoy / segment / GA) queue
            # the event into a setTimeout-driven flush and rely on the
            # browser firing it before navigation tears their context
            # down. Without this drain the tracking POST is lost on
            # every internal link click.
            tick_real_time
            # Link clicks honour `<base href>` (HTML spec); `visit`
            # does not — that's address-bar navigation.
            navigate(resolve_against_current(url, use_base: true))
          end
        when 'submit'
          submit_form_handle(action['formHandle'], action['submitter'])
        when 'download'
          download_link(resolve_against_current(action['url'].to_s), action['filename'].to_s)
        end
      end

      def download_link(url, filename_hint = '')
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_COOKIE']   = document_cookie unless @cookies.empty?
        env['HTTP_REFERER']  = @current_url    unless @current_url.nil? || @current_url.empty?
        status, headers, body = @app.call(env)
        return unless status.to_i == 200
        # Fall back to the link's `download="filename"` value or the
        # URL path tail when Content-Disposition is absent — `<a download>`
        # is the spec hook for naming a download independently of the
        # response headers.
        forced_headers = headers.dup
        if content_disposition_header(forced_headers).to_s.empty?
          name = filename_hint.empty? ? File.basename(URI.parse(url).path.to_s) : filename_hint
          forced_headers['Content-Disposition'] = %(attachment; filename="#{name}") unless name.empty?
        end
        save_downloaded_response(url, forced_headers, body)
      end

      def pure_fragment_navigation?(url)
        return true  if url.start_with?('#')
        return false if @current_url.nil?
        target = resolve_against_current(url)
        a = URI.parse(target)
        b = URI.parse(@current_url)
        a.scheme == b.scheme && a.host == b.host && a.port == b.port && a.path == b.path && a.query == b.query && !a.fragment.nil?
      rescue URI::InvalidURIError
        false
      end

      def update_current_hash(url)
        return if @current_url.nil?
        new_url = resolve_against_current(url)
        @current_url = new_url
      end

      def set_value_with_events(handle, value)
        tick_real_time
        invalidate_find_cache
        # `attach_file` hands us a Pathname (or Array of Pathnames);
        # mini_racer rejects non-primitive types. Coerce to a path-list
        # form V8 can hold. File-input handling stops here for v3 — the
        # form-submit multipart path is a follow-up (v2 stores these in
        # `@file_picks` and reads them back during build_multipart). Most
        # tests that reach this codepath assert the picker UI state
        # after attaching, not the actual upload, so the coerce alone
        # unblocks them.
        coerced = coerce_set_value(value)
        # For date/time-shaped inputs we need the type-specific
        # string. Probe the handle's `type` and re-format Date / Time
        # accordingly — `Date.today` → `2026-05-13` (date input) is
        # already right via to_s, but `Time` needs the input-type-
        # specific format.
        coerced = format_temporal_value(value, handle) if value.is_a?(Date) || value.is_a?(Time)
        @file_picks ||= {}
        # Capybara `attach_file` calls `Node#set` with a Pathname; some
        # callers pass a String path through directly. When the target
        # IS a file input, promote either form into the file-list path
        # so `.files` / `@file_picks` reflect the chosen file.
        coerced = [coerced.to_s] if value.is_a?(Pathname)
        if !coerced.is_a?(Array) && coerced.is_a?(String) && file_input?(handle)
          coerced = [coerced]
        end
        if coerced.is_a?(Array)
          paths = coerced.reject(&:empty?)
          @file_picks[handle] = paths
          # Expose File-list metadata to the JS side BEFORE setting the
          # value: __csimSetValue fires input + change synchronously,
          # and Redmine's onchange="addInputFiles(this)" reads
          # `inputEl.files` — if we set files after, the handler sees
          # an empty FileList and tears down the input.
          file_infos = paths.map {|p|
            stat = (File.stat(p) rescue nil)
            {
              'name'         => File.basename(p),
              'size'         => stat ? stat.size : 0,
              'type'         => '',
              'lastModified' => stat ? (stat.mtime.to_f * 1000).to_i : 0
            }
          }
          @runtime.call('__csimSetFiles', handle, file_infos)
          # Mirror real browser: <input type=file>.value reflects only
          # the filename of the first chosen file (security-faked path).
          # __csimSetValue dispatches input + change synchronously.
          js_value = paths.first ? File.basename(paths.first) : ''
          @runtime.call('__csimSetValue', handle, js_value)
        else
          @runtime.call('__csimSetValue', handle, coerced)
        end
        consume_pending_form_submit
      end

      def coerce_set_value(v)
        case v
        when Pathname then v.to_s
        when Array    then v.map {|x| x.is_a?(Pathname) ? x.to_s : x.to_s }
        else v
        end
      end

      def format_temporal_value(v, handle)
        type = attr(handle, 'type').to_s.downcase
        case type
        when 'date'           then v.respond_to?(:strftime) ? v.strftime('%Y-%m-%d') : v.to_s
        when 'time'           then v.respond_to?(:strftime) ? v.strftime('%H:%M') : v.to_s
        when 'datetime-local' then v.respond_to?(:strftime) ? v.strftime('%Y-%m-%dT%H:%M') : v.to_s
        when 'month'          then v.respond_to?(:strftime) ? v.strftime('%Y-%m')  : v.to_s
        when 'week'           then v.respond_to?(:strftime) ? v.strftime('%Y-W%V') : v.to_s
        else
          v.is_a?(Date) ? v.strftime('%Y-%m-%d') : v.to_s
        end
      end

      def file_picks_for(handle)
        (@file_picks && @file_picks[handle]) || []
      end

      def right_click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
        init = {'bubbles' => true, 'cancelable' => true, 'button' => 2, 'which' => 3}.merge(click_event_init(handle, keys, opts))
        @runtime.call('__csimDispatchEvent', handle, 'mousedown', init)
        sleep opts[:delay].to_f if opts[:delay].to_f > 0
        @runtime.call('__csimDispatchEvent', handle, 'mouseup',     init)
        @runtime.call('__csimDispatchEvent', handle, 'contextmenu', init)
      end

      # HTML5 drag-and-drop simulation. Capybara routes `Element#drop`
      # here with a flat list of paths / Pathnames / Hashes; build a
      # DataTransfer-shaped object and dispatch dragenter / dragover /
      # drop in sequence.
      def drop(handle, args)
        tick_real_time
        invalidate_find_cache
        items = args.flat_map {|arg| drop_items(arg) }
        @runtime.call('__csimDropOnto', handle, items)
      end
      def drop_items(arg)
        case arg
        when Hash
          arg.map {|type, value| {'kind' => 'string', 'type' => type.to_s, 'value' => value.to_s} }
        when ->(x) { x.respond_to?(:to_path) }
          path = arg.to_path
          [{'kind' => 'file', 'name' => File.basename(path), 'path' => path}]
        when String
          [{'kind' => 'file', 'name' => File.basename(arg), 'path' => arg}]
        else
          []
        end
      end

      def double_click(handle, keys = [], **opts)
        tick_real_time
        invalidate_find_cache
        init = {'bubbles' => true, 'cancelable' => true}.merge(click_event_init(handle, keys, opts))
        @runtime.call('__csimDispatchEvent', handle, 'dblclick', init)
      end

      MODIFIER_KEYS = {
        shift:    'shiftKey',
        control:  'ctrlKey',
        ctrl:     'ctrlKey',
        alt:      'altKey',
        option:   'altKey',
        meta:     'metaKey',
        command:  'metaKey'
      }.freeze
      MODIFIER_KEY_NAMES = MODIFIER_KEYS.keys.to_set.freeze
      def modifier_flags(keys)
        Array(keys).each_with_object({}) {|k, h|
          field = MODIFIER_KEYS[k.is_a?(Symbol) ? k : k.to_sym]
          h[field] = true if field
        }
      end

      # Resolve click offset against the element's CSS-declared box.
      # `opts[:offset] == :center` means "x/y is relative to the
      # element's centre" (Capybara's w3c_click_offset semantics);
      # otherwise the offset is relative to the top-left. We don't run
      # a real layout engine — `__csimElementRect` reads
      # top / left / width / height from the cascade so tests that
      # declare those values via CSS see honest coordinates.
      def click_event_init(handle, keys, opts)
        out = modifier_flags(keys)
        has_xy = opts[:x] || opts[:y]
        center = opts[:offset] == :center || !has_xy
        if has_xy || center
          rect = @runtime.call('__csimElementRect', handle)
          base_x = rect['x'].to_f + (center ? rect['width'].to_f  / 2.0 : 0.0)
          base_y = rect['y'].to_f + (center ? rect['height'].to_f / 2.0 : 0.0)
          out['clientX'] = base_x + opts[:x].to_f
          out['clientY'] = base_y + opts[:y].to_f
        end
        out
      end

      def hover(handle)
        tick_real_time
        invalidate_find_cache
        # Set `document._hoverElement` so `:hover` pseudo-class matches
        # resolve against this element (Redmine's gantt tooltips +
        # context-menu submenus rely on CSS `:hover`). The host fn
        # call into `__csimSetHover` does the slot update on the JS
        # side AND fires `mouseover` / `mouseenter` — keeping the
        # state-set and dispatch on the same path avoids the
        # double-eval recursion the inlined `globalThis.document.
        # _hoverElement = ...` triggered (the eval string ran inside
        # a fresh microtask that re-entered the hover listeners).
        @runtime.call('__csimSetHover', handle)
      end

      def dispatch_event(handle, type, init = {})
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimDispatchEvent', handle, type.to_s, init)
      end

      # Capybara's `send_keys` accepts Strings and Symbols (special
      # keys: `:enter`, `:tab`, `:backspace`, …) and Array combos
      # (modifier + key). We hand each item to JS as a tagged atom so
      # the bridge can fire proper KeyboardEvents with `key` / `code`
      # / `ctrlKey` / `metaKey` / `shiftKey` filled in — required by
      # libraries that gate behaviour on the modifier flags (Redmine's
      # jstoolbar reads `event.ctrlKey || event.metaKey` for Ctrl+B /
      # Cmd+B; quote-reply Stimulus controllers read `event.key`).
      # An Array combo is the canonical "modifier + key" pattern:
      # everything but the last entry is a modifier; the last entry
      # is the key being pressed (String char or Symbol special).
      def send_keys(handle, keys)
        tick_real_time
        invalidate_find_cache
        # Selenium's contract: a bare modifier symbol (`:shift`) at the
        # top level "holds" the modifier from that point on. `:null`
        # releases all modifiers. We rewrite the atom stream so each
        # following character / key carries the accumulated modifiers.
        held = []
        atoms = keys.flat_map {|k|
          case k
          when Symbol
            if k == :null
              held = []; nil
            elsif MODIFIER_KEY_NAMES.include?(k)
              held = (held + [k.to_s]).uniq; nil
            else
              held.empty? ? {'kind' => 'key',  'name'  => k.to_s}
                          : {'kind' => 'combo', 'parts' => held + [k.to_s]}
            end
          when String
            held.empty? ? {'kind' => 'text', 'value' => k}
                        : {'kind' => 'combo', 'parts' => held + [k]}
          when Array
            parts = k.map {|x| x.is_a?(Symbol) ? x.to_s : x.to_s }
            {'kind' => 'combo', 'parts' => parts}
          end
        }.compact
        @runtime.call('__csimSendKeys', handle, atoms)
        consume_pending_form_submit
      end

      def select_option(handle)
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimSelectOption', handle)
        tick_real_time
        consume_pending_form_submit
      end

      def unselect_option(handle)
        tick_real_time
        invalidate_find_cache
        # Single-select <select>s can't have a selection cleared per
        # HTML — Capybara surfaces this as `UnselectNotAllowed`. Ask
        # the JS side whether the option's parent select is `multiple`
        # before issuing the unselect; the answer doubles as the
        # "found the right ancestor" check.
        info = @runtime.call('__csimOptionContext', handle)
        if info.is_a?(Hash) && info['hasSelect'] && !info['multiple']
          raise Capybara::UnselectNotAllowed, 'Cannot unselect option from single select box.'
        end
        @runtime.call('__csimUnselectOption', handle)
        tick_real_time
        consume_pending_form_submit
      end

      # Read the form-submit pending intent set by JS-side
      # `form.submit()` / `form.requestSubmit()`. Called by user-action
      # entry points (click is the primary, but a `<select onchange="$
      # ('#form').submit()">` pattern reaches here through
      # select_option). Without this hop the intent sits on the slot
      # forever and the form never actually navigates / POSTs.
      def consume_pending_form_submit
        pending = @runtime.call('__csimTakePendingFormSubmit')
        return unless pending.is_a?(Hash) && pending['formHandle']
        submit_form_handle(pending['formHandle'].to_i, pending['submitterHandle'])
      end

      # `Node#submit(*)` (Capybara DSL) hits here. Find the enclosing
      # form, serialise, post.
      def submit_form(handle)
        tick_real_time
        invalidate_find_cache
        form_handle = @runtime.call('__csimAncestorForm', handle).to_i
        return if form_handle.zero?
        submit_form_handle(form_handle, nil)
      end

      def title
        tick_real_time
        @runtime.call('__csimDocumentTitle').to_s
      end

      def html
        tick_real_time
        @runtime.call('__csimDocumentHtml').to_s
      end

      def status_code      = (@last_response_status || 200)
      # Rack 3 lowercases header names; Capybara tests do `['Content-Type']`.
      def response_headers
        (@last_response_headers || {}).each_with_object({}) {|(k, v), h|
          h[k.to_s.split('-').map(&:capitalize).join('-')] = v
        }
      end
      def record_response(status, headers)
        @last_response_status  = status
        @last_response_headers = headers.to_h
      end

      # Driver surface bits that v2 Browser exposes; stubbed for v3 PoC.
      def set_header(name, value)         ; @sticky_headers[name.to_s] = value.to_s ; end
      # Capybara's `current_window.resize_to(w, h)` lands here; the
      # ahoy hamburger test (mobile breakpoint at 425×694) and any
      # responsive-utility-aware test (Tailwind `m:` show / hide,
      # bootstrap `.d-md-flex`, …) depends on this surfacing through
      # the JS-side `innerWidth` / `innerHeight` so the cascade's
      # `mediaMatches` and `matchMedia()` evaluate against the test's
      # chosen viewport instead of the 1024×768 default.
      def set_viewport(w, h)
        @viewport_width  = w.to_i
        @viewport_height = h.to_i
        invalidate_find_cache
        @runtime.eval("globalThis.innerWidth = #{@viewport_width}; globalThis.innerHeight = #{@viewport_height};")
        # Recompute the cascade `@media` rules against the new
        # viewport so visibility checks (Capybara `visible?`,
        # `getComputedStyle().display`) re-reflect mobile-breakpoint
        # `display: none` / `display: block` flips. Without this the
        # cascade keeps the pre-resize hide-rule set.
        @runtime.call('__csimRebuildCascade') if @document_handle.to_i > 0
        # Re-fire a `resize` event so libraries that re-layout on
        # resize (responsive nav, sidebar collapse) see the new size.
        @runtime.eval("try { (globalThis.dispatchEvent || function(){})(new Event('resize')); } catch (_) {}")
        nil
      end
      def viewport_width                  ; @viewport_width  || 1024 ; end
      def viewport_height                 ; @viewport_height || 768  ; end
      def go_back
        return if @history_idx <= 0
        @history_idx -= 1
        replay_history_entry(@history[@history_idx])
      end
      def go_forward
        return if @history_idx + 1 >= @history.size
        @history_idx += 1
        replay_history_entry(@history[@history_idx])
      end
      def record_history(entry)
        # Discard any forward-history tail (a real browser drops the
        # redo stack the moment you navigate after a `go_back`).
        @history = @history[0..@history_idx] if @history_idx + 1 < @history.size
        @history << entry
        @history_idx = @history.size - 1
      end
      def replay_history_entry(entry)
        return unless entry
        if entry[:method] == :post
          navigate_post(entry[:url], entry[:body], entry[:content_type], from_history: true)
        else
          navigate(entry[:url], from_history: true)
        end
      end
      def active_element_handle
        tick_real_time
        h = @runtime.call('__csimActiveElement').to_i
        h.zero? ? nil : h
      end
      def session_send_keys(_)            ; nil ; end

      # Session-level keystroke. Tab / shift-tab cycle focus; everything
       # else is routed to the currently focused element (if any) as a
       # plain keydown/keyup pair.
      def send_session_key(key)
        sym = key.is_a?(Symbol) ? key : (key.respond_to?(:to_sym) ? key.to_sym : nil)
        case sym
        when :tab       then @runtime.call('__csimAdvanceFocus',  false)
        when :backtab   then @runtime.call('__csimAdvanceFocus',  true)
        else
          handle = active_element_handle
          send_keys(handle, [key]) if handle
        end
      end
      def with_modal(_)                   ; yield ; end
      attr_reader :trace, :pending_trace, :trace_mode

      TRACE_MODES = {'off' => :off, 'on-failure' => :on_failure, 'full' => :full}.freeze
      private_constant :TRACE_MODES

      def parse_trace_mode(raw)
        return :on_failure if raw.nil? || raw.empty?
        TRACE_MODES[raw] || raise(ArgumentError, "CSIM_TRACE must be one of #{TRACE_MODES.keys.join(', ')}; got #{raw.inspect}")
      end

      def start_trace(metadata = {})
        @trace = Trace.new(metadata: metadata)
        @runtime.call('__csimSetTraceActive', true)
      end

      # Persist `trace` (defaults to live or pending) to `path` and
      # return the path. Doesn't clear — `clear_trace!` is the explicit
      # follow-up so a caller can inspect after writing if it wants.
      def finish_trace_to(path, trace = (@trace || @pending_trace))
        return nil unless trace
        trace.write_json(path)
      end

      def clear_trace!
        @trace         = nil
        @pending_trace = nil
        @runtime.call('__csimSetTraceActive', false)
      end

      # Wraps a driver action so the trace records description, urls,
      # console / network activity, and (on action error / full mode)
      # a post-action DOM snapshot. Re-entrant: nested recorded actions
      # (label-click → click, session send_keys → send_keys) let the
      # outer step own the boundary and the inner just yields.
      #
      # `description` is a String or Proc — Procs are lazy-evaluated
      # only when a step is actually being recorded, so the off-path
      # doesn't pay `describe_node_handle`'s V8 round-trip.
      def record_action(kind, description)
        # Off-mode: no autostart, only proceed if a trace was started
        # explicitly via `driver.start_tracing`. Hot path for users
        # who set CSIM_TRACE=off.
        return yield if @trace.nil? && @trace_mode == :off
        if @trace.nil?
          @trace = Trace.new(metadata: {auto_started_at: Time.now.utc.iso8601(3)})
          @runtime.call('__csimSetTraceActive', true)
        end
        return yield if @recording_action
        @recording_action = true
        desc = description.is_a?(Proc) ? description.call : description
        @trace.begin_step(kind, description: desc, url_before: @current_url)
        error = nil
        begin
          yield
        rescue => e
          error = {class: e.class.name, message: e.message}
          raise
        ensure
          # `full` mode serializes the document after every action; the
          # default `on_failure` mode only snapshots when an action
          # errored. The V8 round-trip + DOM serialize is the
          # expensive part of trace recording, so skipping it on the
          # happy path is the whole point of the default.
          dom = (error || @trace_mode == :full) ? html : nil
          @trace.finish_step(url_after: @current_url, dom_after: dom, error: error)
          @recording_action = false
        end
      end

      def log_console(severity, message) = @trace&.log_console(severity, message)
      def log_network(method, url, status) = @trace&.log_network(method, url, status)

      # `tag#id.class` short description of the handle, for trace
      # `description` fields. One V8 round-trip; only paid when a step
      # is actively being recorded (`record_action` lazy-evaluates the
      # description Proc).
      def describe_node_handle(handle)
        return "handle=#{handle}" if handle.nil? || handle.zero?
        info = @runtime.call('__csimDescribeNode', handle)
        return "handle=#{handle}" unless info.is_a?(Hash)
        s = info['tag'].to_s
        s += "##{info['id']}"  unless info['id'].to_s.empty?
        s += ".#{info['cls']}" unless info['cls'].to_s.empty?
        s
      end
      def evaluate_script(code, args = [])
        # Drain timers first so ready handlers (jQuery `$(handler)`,
        # framework `DOMContentLoaded` listeners) run before the
        # user's script. Without this, `execute_script` can fire
        # *before* the page's own setup code that the test expects
        # to be active.
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimEvalScript', code.to_s, marshal_args(args || []))
      end

      # Fire-and-forget variant: runs the script but never returns
      # its value to Ruby. Lets execute_script handle scripts whose
      # return is a complex JS object (jQuery chainable, DOM tree,
      # …) that mini_racer's value filter would recurse into.
      def execute_script(code, args = [])
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimExecScript', code.to_s, marshal_args(args || []))
      end

      # Capybara passes Node instances directly as script args
      # (`session.evaluate_script('arguments[0].click()', some_node)`).
      # mini_racer can't marshal a Ruby Node, so wrap as a sentinel
      # the JS side recognises and rehydrates via the handle registry.
      def marshal_args(args)
        args.map {|a|
          case a
          when Capybara::Simulated::V3Node then {'__elementHandle' => a.handle_id}
          when Array                       then marshal_args(a)
          when Hash                        then a.transform_values {|v| marshal_args([v]).first }
          else a
          end
        }
      end
      def evaluate_async_script(code, args = [])
        tick_real_time
        invalidate_find_cache
        @runtime.call('__evalAsyncScript', code.to_s, marshal_args(args || []))
        # Pump virtual time so any setTimeout-driven completion lands.
        # Capybara's polling can't help here — we're inside one session
        # call, not a retry loop.
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) +
                   Capybara.default_max_wait_time.to_f
        loop do
          result = @runtime.call('__pollAsyncResult')
          return result['value'] if result.is_a?(Hash) && result.key?('value')
          break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
          sleep 0.01
          tick_real_time
        end
        nil
      end

      def current_path
        tick_real_time
        return '' if @current_url.nil? || @current_url.empty?
        URI.parse(@current_url).path
      rescue URI::InvalidURIError
        ''
      end

      # Capybara polls find / has_? via `synchronize` while
      # `Driver#wait?` is true. We stay true while there's any scheduled
      # timer (`@timers_active` is flipped by the JS bridge's
      # `__setTimersActive` callback), plus a sticky grace window after
      # the last timer fires so a `setTimeout` firing mid-loop doesn't
      # drop us off polling before Capybara's own retry deadline.
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

      # Advance the virtual JS clock by however much wall-clock has
      # elapsed since the last tick, then fire any timers that came
      # due. Each find / has_? path goes through here, so Capybara's
      # polling cadence is what drives `setTimeout(N)` forward.
      def tick_real_time
        return unless @timers_active
        # Re-entrancy guard. Capybara's `Result#each` triggers nested
        # finds (visible? per element); the outermost tick has already
        # advanced the clock, the inner calls would only re-drain
        # already-fired timers.
        return if @ticking
        @ticking = true
        begin
          now      = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          elapsed  = ((now - @last_tick_ts) * 1000).to_i
          @last_tick_ts = now
          step = [[elapsed, TICK_MIN_MS].max, TICK_CAP_MS].min
          if step > 0
            fired = @runtime.drain_timers(step).to_i
            @find_cache_dirty = true if fired > 0
          end
        ensure
          @ticking = false
        end
        # Drain navigation intents queued by JS-side handlers that fired
        # during the drain (e.g. `setTimeout(() => location.pathname = X)`).
        # Outside the @ticking guard so the navigate's rebuild_ctx is
        # well-clear of the V8 call we just made.
        consume_pending_location if @pending_location
        # Same shape for `form.submit()` queued by a timer callback —
        # Forem's comment-edit form has an `onsubmit` handler that
        # `preventDefault`s, polls for the CSRF meta tag inside
        # `setInterval(…, 1)`, then calls `form.submit()` once the
        # meta is present. The click that originally fired the submit
        # event has already returned by the time the interval triggers,
        # so without this drain the intent sits on the slot forever
        # and the form never posts.
        consume_pending_form_submit
      end

      # Re-sync the Ruby-side timer mirror with a freshly-rebuilt JS
      # context. The JS bridge resets `__virtualNow` to 0 and clears
      # all timers on every context rebuild; if `@last_tick_ts` stayed
      # at its pre-rebuild value, the next `tick_real_time` would
      # treat the entire app-boot interval as elapsed wall time and
      # drain up to 5 s of virtual clock in one step — firing wait-
      # duration timers prematurely. Also clear `@timers_active` and
      # the `@polling_until` grace window so the previous page's
      # pending-timer state doesn't leak into the next test, leaving
      # `Driver#wait?` true and dragging every failing matcher
      # through the full `default_max_wait_time` retry loop.
      def reset_timer_state
        @last_tick_ts  = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @timers_active = false
        @polling_until = nil
        @context_gen  += 1
      end

      attr_reader :context_gen

      # Pulls the serialised form-state out of JS, encodes it, and
      # drives the Rack app via `navigate` (for GET) or a POST. Mirrors
      # the slice of <form> semantics rack-test supports — multipart
      # uploads lift in with milestone 4+ once <input type=file> matters.
      def submit_form_handle(form_handle, submitter_handle)
        invalidate_find_cache
        spec = @runtime.call('__csimFormSerialize', form_handle, submitter_handle || 0)
        return unless spec.is_a?(Hash)
        action  = spec['action'].to_s
        method  = spec['method'].to_s.upcase
        method  = 'GET' if method.empty?
        fields  = (spec['fields'] || []).map {|pair| [pair[0].to_s, pair[1].to_s] }
        file_inputs = spec['fileInputs'] || []
        enctype = spec['enctype'].to_s
        multipart = enctype.start_with?('multipart/form-data')
        content_type = nil
        body =
          if multipart
            built = build_multipart_body(fields, file_inputs)
            content_type = built[:content_type]
            built[:body]
          else
            # Non-multipart: file inputs contribute the filename only.
            file_inputs.each do |fi|
              picks = @file_picks && @file_picks[fi['handle'].to_i] || []
              fields << [fi['name'].to_s, picks.first ? File.basename(picks.first) : '']
            end
            URI.encode_www_form(fields)
          end
        action_url = action.empty? ? (@current_url || DEFAULT_HOST) : resolve_against_current(action)
        if method == 'GET'
          uri = URI.parse(action_url)
          uri.query = body unless body.empty?
          navigate(uri.to_s)
        else
          navigate_post(action_url, body, content_type || enctype)
        end
      end

      def build_multipart_body(fields, file_inputs)
        boundary = "csim-#{SecureRandom.hex(8)}"
        body     = String.new.force_encoding(Encoding::ASCII_8BIT)
        fields.each do |name, value|
          append_multipart_part(body, boundary, name, value.to_s)
        end
        file_inputs.each do |fi|
          picks = @file_picks && @file_picks[fi['handle'].to_i] || []
          if picks.empty?
            append_multipart_part(body, boundary, fi['name'].to_s, '', filename: '')
          else
            picks.each do |path|
              append_multipart_part(body, boundary, fi['name'].to_s, File.binread(path),
                                    filename:     File.basename(path),
                                    content_type: Rack::Mime.mime_type(File.extname(path)))
            end
          end
        end
        body << "--#{boundary}--\r\n"
        {content_type: "multipart/form-data; boundary=#{boundary}", body: body}
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

      def navigate_post(url, body, content_type, depth: 0, from_history: false)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        record_history({method: :post, url: url, body: body, content_type: content_type}) unless from_history || depth > 0
        env = Rack::MockRequest.env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        env['HTTP_COOKIE']    = document_cookie unless @cookies.empty?
        env['HTTP_REFERER']   = @current_url    unless @current_url.nil? || @current_url.empty?
        @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        status, headers, resp_body = @app.call(env)
        merge_set_cookie(headers)
        if (300..399).include?(status) && headers['location']
          next_url = resolve_against_current(headers['location'])
          resp_body.close if resp_body.respond_to?(:close)
          # HTTP semantics: 301/302/303 → method becomes GET; 307/308
          # require the method (and body) to be preserved.
          if [307, 308].include?(status)
            return navigate_post(next_url, body, content_type, depth: depth + 1)
          else
            return navigate(next_url, depth: depth + 1)
          end
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, resp_body)
          return
        end
        @current_url = url
        record_response(status, headers)
        html         = read_rack_body(resp_body)
        # Same rebuild-on-full-load contract as `navigate`. POST
        # responses (form submissions that don't redirect, AJAX-less
        # data-remote replies) replace the page; we follow real-browser
        # semantics and bring up a fresh VM rather than papering over
        # the previous one's state.
        @runtime.rebuild_ctx
        reset_timer_state
        apply_esm_flag
        apply_trace_flag
        apply_viewport
        @runtime.call('__csimUpdateLocation', @current_url.to_s)
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
      end

      def reset!
        @cookies.clear
        @local_storage.clear
        @session_storage.clear
        @sticky_headers.clear
        # The driver-side resize buffer has to clear too — without
        # this the previous test's `driver.resize(425, …)` leaks into
        # the next test's default viewport and any cascade rule that
        # gates on `(min-width: …)` reports the wrong answer for the
        # whole new test (Forem's comment-actions dropdown is
        # mobile-collapsed-by-default).
        @viewport_width = nil
        @viewport_height = nil
        @current_url     = nil
        @document_handle = 0
        @history.clear
        @history_idx     = -1
        @file_picks      = {} if @file_picks
        # Hand the live trace off to `@pending_trace` so an after-hook
        # running after `reset_session!` (Capybara's per-test teardown
        # order) still finds it. Anything stuck in `@pending_trace`
        # from a prior test is dropped — better than fusing two
        # tests' actions into one record.
        @pending_trace    = @trace
        @trace            = nil
        @recording_action = false
        @runtime.reset_page
        # Per-visit ctx rebuild drops the JS-side trace-active flag,
        # so re-flip it if we're carrying a pending trace into the
        # next visit (apply_esm_flag pattern).
        @runtime.call('__csimSetTraceActive', false)
        reset_timer_state
        invalidate_find_cache
      end

      # ── Host-fn callbacks invoked by v3_bridge.js ───────────────

      # JS-side loader callback: hand back the rewritten module body
      # for `url` (import specifiers resolved through the active
      # importmap + EsmRewriter applied). Cached at Browser scope so
      # the rewrite cost is paid once per (URL, importmap) — the cache
      # survives Context rebuilds (between-test reset + per-navigate
      # rebuild) and is flushed only when `set_importmap` detects a
      # change. Inline modules are pre-registered via the JS-side
      # `__csim_inlineSources` map, indexed by hashed-body URL — we
      # surface them here so the same cache covers both paths.
      def load_module(url)
        return @module_cache[url] if @module_cache.key?(url)
        body =
          if url.to_s.include?('#inline-')
            # Inline-module sentinel: when the JS bridge sees a
            # `<script type="module">` without `src`, it synthesises a
            # URL of the form `<page>#inline-<hash>` and stashes the
            # body in `__csim_inlineSources[url]`. Pull it back.
            inline = @runtime.eval("(globalThis.__csim_inlineSources || {})[#{url.to_json}] || null")
            inline&.to_s
          else
            rack_fetch_body(url)
          end
        return @module_cache[url] = nil unless body
        resolved  = rewrite_module_imports(body, url)
        rewritten = EsmRewriter.rewrite(resolved).first
        @module_cache[url] = rewritten
      end

      def rack_fetch_body(url)
        result = rack_fetch('GET', url, '', {}, 'follow')
        return nil unless result && result['status'].to_i < 400
        result['body'].to_s
      end

      # Resolve every static / dynamic import specifier in `source` to
      # an absolute URL so EsmRewriter (and the JS-side loader) can
      # treat them as opaque keys. Bare specifiers go through the
      # importmap; everything else is URL-joined against the importer.
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

      # JS-side `ingestImportmaps` calls this through the host fn so
      # Ruby-side `resolve_module_specifier` and JS-side
      # `__csim_resolveSpecifier` agree on the bare-specifier map.
      # Flush `@module_cache` whenever the importmap actually changes —
      # cached module bodies embed import URLs that were resolved
      # against the previous map. For apps with a stable importmap
      # across pages (the common case) this preserves cache hits
      # across navigations.
      def set_importmap(json)
        parsed = begin
          JSON.parse(json.to_s)
        rescue JSON::ParserError
          {'imports' => {}, 'scopes' => {}}
        end
        @module_cache = {} if @importmap && @importmap != parsed
        @importmap = parsed
      end

      def resolve_module_specifier(specifier, base_url)
        @importmap ||= {'imports' => {}, 'scopes' => {}}
        if (mapped = @importmap['imports'][specifier])
          return resolve_against(mapped, base_url)
        end
        if specifier.start_with?('/', './', '../') || specifier.match?(%r{\A[a-z]+://}i)
          return resolve_against(specifier, base_url)
        end
        specifier
      end

      def resolve_against(url, base)
        return url if url =~ %r{\A[a-z]+://}i
        require 'uri'
        URI.join(base || @current_url || DEFAULT_HOST, url).to_s
      rescue URI::InvalidURIError
        url
      end

      def rack_fetch_body(url)
        result = rack_fetch('GET', url, '', {}, 'follow')
        return nil unless result && result['status'].to_i < 400
        result['body'].to_s
      end

      MAX_FETCH_REDIRECTS = 20
      def rack_fetch(method, url, body, headers, redirect_mode)
        target = resolve_against_current(url.to_s)
        method = (method || 'GET').to_s.upcase
        redirected = false
        MAX_FETCH_REDIRECTS.times do
          env = Rack::MockRequest.env_for(target, method: method, input: body || '')
          (headers || {}).each {|k, v|
            name = k.to_s.upcase.tr('-', '_')
            # CGI convention: `Content-Type` and `Content-Length` land in
            # the env *without* the HTTP_ prefix. Rails / Rack params
            # parsing reads `CONTENT_TYPE` and dispatches JSON / multipart
            # parsers off it; sending it as `HTTP_CONTENT_TYPE` lets the
            # request through but with the default `text/plain`, so JSON
            # bodies from `@rails/request.js` never deserialise and the
            # server reads an empty params hash.
            if name == 'CONTENT_TYPE' || name == 'CONTENT_LENGTH'
              env[name] = v.to_s
            else
              env["HTTP_#{name}"] = v.to_s
            end
          }
          @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] ||= v }
          env['HTTP_REFERER'] = @current_url unless @current_url.nil? || @current_url.empty?
          @cookies.each {|k, v| env['HTTP_COOKIE'] = "#{env['HTTP_COOKIE']}#{env['HTTP_COOKIE'] ? '; ' : ''}#{k}=#{v}" }
          status, resp_headers, resp_body = @app.call(env)
          merge_set_cookie(resp_headers)
          log_network(method, target, status)
          if redirect_mode != 'manual' && (loc = redirect_location(status, resp_headers))
            raise StandardError, '[capybara-simulated v3] fetch: redirect blocked by redirect=error mode' if redirect_mode == 'error'
            redirected = true
            preserve = [307, 308].include?(status)
            next_url = resolve_against(loc, target)
            target = carry_fragment(target, next_url)
            method = 'GET' unless preserve
            body = nil unless preserve
            resp_body.close if resp_body.respond_to?(:close)
            next
          end
          body_str = read_rack_body(resp_body)
          return {
            'status' => status,
            'headers' => stringify(resp_headers),
            'body' => body_str,
            'url' => target,
            'redirected' => redirected,
            'type' => 'basic'
          }
        end
        raise StandardError, "[capybara-simulated v3] fetch exceeded #{MAX_FETCH_REDIRECTS} redirects"
      rescue StandardError => e
        warn "[capybara-simulated v3] rack_fetch failed: #{e.class}: #{e.message[0, 200]}"
        nil
      end

      # Rack response bodies must respond to `each` (or be an Array of
      # strings). `to_s` on a streaming body returns the inspect form,
      # not the bytes — which silently shipped 43-byte `#<Rack::Files…>`
      # strings to the JS engine for big assets like jquery.js.
      def read_rack_body(body)
        buf = +''
        body.each {|chunk| buf << chunk.to_s } if body.respond_to?(:each)
        body.close if body.respond_to?(:close)
        buf
      end

      # Defer the navigation: doing it from inside the running V8 call
      # would dispose the Context mid-call. tick_real_time drains
      # after the call returns. Same pattern as `__csimPendingFormSubmit`.
      def location_assign(url)
        @pending_location = resolve_against_current(url.to_s)
      end
      def consume_pending_location
        return unless (url = @pending_location)
        @pending_location = nil
        navigate(url)
      end
      # POST-after-POST resubmits with the original body; GET-after-GET
       # is just a re-GET. Replay the current history entry.
      def refresh
        replay_history_entry(@history[@history_idx])
      end
      def history_state(url)   ; @current_url = url.to_s ; end
      def set_listened_type(*) ; end
      def document_cookie      ; @cookies.map {|k, v| "#{k}=#{v}" }.join('; ') ; end
      def write_document_cookie(s)
        return if s.nil? || s.empty?
        name, rest = s.split('=', 2)
        @cookies[name] = (rest || '').split(';', 2).first.to_s
      end

      # Web Storage host-fn shims. The Ruby-side hashes survive
      # `rebuild_ctx` between visits, so apps that cache user data in
      # `localStorage` on page A (Forem's `browserStoreCache('set')`
      # inside fetchBaseData) see it on page B — without this, every
      # visit boots into a JS-side Map that starts empty and the
      # first-call branches that hinge on cached user data (the
      # onboarding task-card render, `initializeLocalStorageRender`,
      # etc.) silently skip.
      def storage_get(kind, key)
        store(kind)[key.to_s]
      end
      def storage_set(kind, key, value)
        store(kind)[key.to_s] = value.to_s
        nil
      end
      def storage_remove(kind, key)
        store(kind).delete(key.to_s)
        nil
      end
      def storage_clear(kind)
        store(kind).clear
        nil
      end
      def storage_key(kind, index)
        store(kind).keys[index.to_i]
      end
      def storage_length(kind)
        store(kind).size
      end
      private def store(kind)
        kind.to_s == 'session' ? @session_storage : @local_storage
      end
      # Push a one-shot handler onto the modal-dialog stack — the next
      # modal that fires consumes the topmost handler. Block exit pops
      # in case the dialog never fired. Mirrors v2's `with_modal`.
      def with_modal(handler)
        @modal_handlers.push(handler)
        yield if block_given?
      ensure
        @modal_handlers.delete(handler)
      end

      # JS-side `alert(...)` / `confirm(...)` / `prompt(...)` route here.
      # If no handler is pushed (typical of apps under test), accept
      # the dialog (Rails system-test default) so `data-turbo-confirm`
      # / similar progress without an explicit `accept_confirm` in
      # the test.
      def handle_modal(type, message, default_value)
        handler = @modal_handlers.pop
        if handler
          handler.call(type, message, default_value)
        else
          case type.to_s
          when 'alert'   then nil
          when 'confirm' then true
          when 'prompt'  then default_value.to_s
          end
        end
      end

      private

      # PoC navigate: fetch via the Rack app, hand the body to V8 for
      # parsing. Only follows 3xx redirects up to a small depth.
      def navigate(url, depth: 0, referer: @current_url, from_history: false)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        record_history({method: :get, url: url}) unless from_history || depth > 0
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_COOKIE']   = document_cookie unless @cookies.empty?
        env['HTTP_REFERER']  = referer         unless referer.nil? || referer.empty?
        @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        status, headers, body = @app.call(env)
        merge_set_cookie(headers)
        if (300..399).include?(status) && headers['location']
          next_url = resolve_against_current(headers['location'])
          # Per RFC 7231: if the original request URL had a fragment
          # and the redirect target doesn't specify one, preserve
          # the original fragment in the final URL.
          next_url = carry_fragment(url, next_url)
          body.close if body.respond_to?(:close)
          return navigate(next_url, depth: depth + 1)
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, body)
          return
        end
        @current_url = url
        record_response(status, headers)
        html         = read_rack_body(body)
        # @module_cache and @importmap survive across navigates;
        # set_importmap flushes the cache only when the new page
        # ships a different importmap (handles cross-app navigation).
        # Full-reload navigation rebuilds the JS Context from the warm
        # snapshot. Mirrors v2's pool-checkout model: per-visit fresh VM
        # avoids the partial-reset drift (jQuery `.ready`, rails-ujs
        # `_rails_loaded`, accumulated `$(document).on(...)` delegates)
        # that bit us when state leaked between visits. Snapshot warmup
        # keeps the rebuild cost at a few ms; the cost dominator is
        # re-evaluating app bundles, which is what we want.
        @runtime.rebuild_ctx
        reset_timer_state
        apply_esm_flag
        apply_trace_flag
        apply_viewport
        @runtime.call('__csimUpdateLocation', @current_url.to_s)
        # `__csimLoadDocument` walks importmaps + module scripts during
        # `runInlineScripts`. The JS bridge pushes the importmap back
        # to Ruby via `__csim_pushImportmap` before any module loads,
        # so `load_module` sees the fully-merged map.
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
      end

      # `Content-Disposition: attachment` (or any explicit filename
      # in inline form) is the canonical "save to disk" signal that
      # browsers honour. Tests that exercise CSV / PDF / etc. exports
      # use Redmine's `downloaded_file` helper to read the bytes
      # back from `tmp/downloads/`; routing the response through the
      # save path here keeps the page state unchanged (no rebuild),
      # mirroring what a real browser does after a download.
      def content_disposition_header(headers)
        headers['content-disposition'] || headers['Content-Disposition']
      end

      def download_response?(headers)
        cd = content_disposition_header(headers)
        cd && cd.to_s.match?(/(?:^|;)\s*(attachment|filename\s*=)/i)
      end

      def save_downloaded_response(url, headers, body)
        cd = content_disposition_header(headers).to_s
        m = cd.match(/filename\*?\s*=\s*(?:"([^"]+)"|([^;]+))/i)
        filename = (m && (m[1] || m[2]) || '').strip
        filename = File.basename(URI.parse(url.to_s).path.to_s) if filename.empty?
        filename = 'download' if filename.empty?
        dir = downloads_directory
        FileUtils.mkdir_p(dir)
        File.binwrite(File.join(dir, filename), read_rack_body(body))
      end

      def downloads_directory
        ENV['CSIM_DOWNLOADS_DIR'] || Capybara.save_path || File.join(Dir.pwd, 'tmp', 'downloads')
      end

      def merge_set_cookie(headers)
        sc = headers['set-cookie'] || headers['Set-Cookie']
        return if sc.nil? || sc.empty?
        # Rack 2 returns multiple Set-Cookie headers as a single
        # newline-separated string; Rack 3 returns an Array. Treat both
        # uniformly — splitting first means the second cookie in a
        # multi-cookie response (Rails' session cookie alongside the
        # remember_user_token) doesn't get silently dropped.
        lines = sc.is_a?(Array) ? sc : sc.split("\n")
        lines.each {|line|
          pair, * = line.split(';', 2)
          name, value = pair.to_s.split('=', 2)
          next if name.nil? || name.empty?
          @cookies[name.strip] = value.to_s.strip
        }
      end

      def stringify(headers)
        out = {}
        headers.each {|k, v| out[k.to_s] = v.is_a?(Array) ? v.join(',') : v.to_s }
        out
      end

      def redirect_location(status, headers)
        return nil unless (300..399).include?(status.to_i)
        headers['location'] || headers['Location']
      end

      def resolve_against_current(url, use_base: false)
        return url if url =~ %r{\A[a-z]+://}i
        require 'uri'
        base =
          if use_base && (bh = base_href) && !bh.empty?
            # The document's `<base href>` takes precedence over the
            # request URL when the page's own links / form actions are
            # being resolved — HTML's base-tag semantics. `visit` skips
            # this branch so an address-bar navigation reaches the URL
            # the test typed.
            URI.join(@current_url || DEFAULT_HOST, bh).to_s
          else
            @current_url || DEFAULT_HOST
          end
        URI.join(base, url.to_s).to_s
      rescue URI::InvalidURIError
        url
      end

      def base_href
        @runtime.call('__csimBaseHref').to_s
      end

      def carry_fragment(from_url, to_url)
        from = URI.parse(from_url.to_s)
        to   = URI.parse(to_url.to_s)
        return to_url if to.fragment || from.fragment.nil? || from.fragment.empty?
        to.fragment = from.fragment
        to.to_s
      rescue URI::InvalidURIError
        to_url
      end

      # Trace-wrap layer: prepended so the canonical method bodies above
      # stay un-instrumented and a no-trace caller pays only the
      # `record_action` early-exit. `super` forwards to the real impl
      # within the `record_action` block, which handles begin/finish
      # step bookkeeping + on-failure DOM snapshot.
      module RecordedActions
        def visit(url)
          record_action(:visit, "visit #{url}") { super }
        end
        def refresh
          record_action(:refresh, 'refresh') { super }
        end
        def go_back
          record_action(:go_back, 'go_back') { super }
        end
        def go_forward
          record_action(:go_forward, 'go_forward') { super }
        end
        def click(handle, keys = [], **opts)
          record_action(:click, -> { "click #{describe_node_handle(handle)}" }) { super }
        end
        def set_value_with_events(handle, value)
          record_action(:set, -> { "set #{describe_node_handle(handle)} = #{value.inspect[0, 80]}" }) { super }
        end
        def send_keys(handle, keys)
          record_action(:send_keys, -> { "send_keys #{describe_node_handle(handle)} #{keys.inspect[0, 80]}" }) { super }
        end
        def select_option(handle)
          record_action(:select, -> { "select #{describe_node_handle(handle)}" }) { super }
        end
        def unselect_option(handle)
          record_action(:unselect, -> { "unselect #{describe_node_handle(handle)}" }) { super }
        end
        def submit_form(handle)
          record_action(:submit, -> { "submit #{describe_node_handle(handle)}" }) { super }
        end
      end
      prepend RecordedActions
    end
  end
end
