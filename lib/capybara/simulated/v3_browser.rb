# frozen_string_literal: true

# v3 PoC Browser. Standalone — does *not* inherit from the v2
# `Browser` because the whole point of v3 is to drop the Nokogiri
# tree and its accumulated machinery. Subset of `Browser`'s surface
# wired up so a `Capybara::Session` can `visit` and `find` against
# the V8-resident DOM. Milestones 3+ grow this incrementally.

require 'fileutils'
require 'json'
require 'nokogiri'
require 'rack/mock'
require 'uri'
require_relative 'errors'
require_relative 'esm_rewriter'
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
        @sticky_headers               = {}
        @timers_active                = false
        @intersection_observer_active = false
        # Bumped on each context rebuild. V3Node captures this at
        # construction and `check_stale` rejects any handle whose
        # captured generation no longer matches — handle IDs are
        # per-Context integer sequences, so a handle from a pre-refresh
        # context could otherwise collide with a fresh node in the
        # new context and silently dodge staleness detection.
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
        @modal_handlers               = []
        @module_cache                 = {}
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

      # ── Capybara DSL surface (just enough for milestone 2) ──────

      def visit(url)
        # Address-bar navigation: no Referer, even if we already had
        # a page loaded. Link clicks / form submits / `location.assign`
        # routes do carry the current URL as Referer, which the default
        # `navigate` arg handles.
        navigate(resolve_against_current(url), referer: nil)
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
        tick_real_time
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
              # `Nokogiri::CSS.xpath_for("h1, p")` returns one xpath per
              # selector group. Union them with ` | ` so the wgxpath
              # pass returns matches across all groups in document order
              # instead of just the first group.
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
        cached_find(:css, s, context_handle) do
          @runtime.call('__csimQuery', context_handle || @document_handle, s).to_a
        end
      end

      def find_first_css(css, context_handle = nil)
        tick_real_time
        s = css.to_s
        cached_find(:css_first, s, context_handle) do
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
        tick_real_time
        xpath_str = xpath.to_s
        cached_find(:xpath, xpath_str, context_handle) do
          if XPATH_BACKEND == :nokogiri
            find_xpath_via_nokogiri(xpath, context_handle)
          else
            @runtime.call('__csimEvaluateXPath', xpath_str, context_handle || 0).to_a
          end
        end
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

      # Capybara::Driver::Node surface ----------------------------------
      #
      # PoC: text == all_text == visible_text. Cascade-driven visibility
      # filtering is deferred (V3_DESIGN.md milestone 5+). V3Node calls
      # `check_stale` before each of these, and `check_stale` advances
      # the virtual clock — so a single tick covers both the staleness
      # decision and the read against post-drain state.
      def all_text(handle)     = text(handle)
      def visible_text(handle) = @runtime.call('__csimVisibleText', handle).to_s
      def tag_name(handle)     = tag(handle)
      def value(handle)        = @runtime.call('__csimValue', handle)
      def disabled?(handle)    = @runtime.call('__csimDisabled', handle)
      def option_selected?(h)  = !!attr(h, 'selected')
      def shadow_root_handle(_) = nil
      def computed_style(handle, names)
        result = @runtime.call('__csimComputedStyle', handle, names.map(&:to_s))
        return names.to_h {|n| [n, ''] } unless result.is_a?(Hash)
        result.transform_keys(&:to_s)
      end
      def node_path(_)         = ''

      def lookup_node(handle)
        handle if @runtime.call('__csimAlive', handle)
      end

      # Advance the virtual clock first so a `setTimeout`-driven DOM
      # mutation that detaches `handle` between Capybara's polls is
      # observed before the staleness check decides whether the
      # node is still in the document. Without this, V3Node#check_stale
      # would read the pre-drain state and let a stale handle's
      # subsequent read return empty content instead of raising.
      def check_stale(handle, initial, gen = nil)
        tick_real_time
        return if initial && (gen.nil? || gen == @context_gen) && @runtime.call('__csimAlive', handle)
        raise Capybara::Simulated::StaleElement, "Element with handle #{handle} is no longer attached to the document"
      end

      # PoC click: anchors with href navigate; submit buttons trigger a
      # form submission through the Rack app. Checkbox / radio toggle
      # inline on the JS side (no Ruby trip). Everything else is a
      # no-op until milestone 4 lands event dispatch.
      def click(handle, keys = [], **_opts)
        tick_real_time
        invalidate_find_cache
        action = @runtime.call('__csimClickResolve', handle, modifier_flags(keys))
        return unless action.is_a?(Hash)
        case action['kind']
        when 'navigate'
          url = action['url'].to_s
          # In-page anchor links (`#frag` / current-page + `#frag`) move
          # the hash but don't fetch a new document. Pure-fragment also
          # short-circuits the `<a>`s test fixtures use as click sinks.
          if pure_fragment_navigation?(url)
            update_current_hash(url)
          else
            navigate(resolve_against_current(url))
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

      def file_picks_for(handle)
        (@file_picks && @file_picks[handle]) || []
      end

      def right_click(handle, keys = [], **_opts)
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimDispatchEvent', handle, 'contextmenu', {'bubbles' => true, 'cancelable' => true}.merge(modifier_flags(keys)))
      end

      def double_click(handle, keys = [], **_opts)
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimDispatchEvent', handle, 'dblclick', {'bubbles' => true, 'cancelable' => true}.merge(modifier_flags(keys)))
      end

      # Capybara passes a flat array of modifier symbols (`[:shift,
      # :control]`) to `click` / `right_click` / `double_click`. Map
      # them to the MouseEventInit fields the JS dispatch path reads.
      MODIFIER_KEYS = {
        shift:    'shiftKey',
        control:  'ctrlKey',
        ctrl:     'ctrlKey',
        alt:      'altKey',
        option:   'altKey',
        meta:     'metaKey',
        command:  'metaKey'
      }.freeze
      def modifier_flags(keys)
        Array(keys).each_with_object({}) {|k, h|
          field = MODIFIER_KEYS[k.is_a?(Symbol) ? k : k.to_sym]
          h[field] = true if field
        }
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
        atoms = keys.map {|k|
          case k
          when String then {'kind' => 'text', 'value' => k}
          when Symbol then {'kind' => 'key',  'name'  => k.to_s}
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
        consume_pending_form_submit
      end

      def unselect_option(handle)
        tick_real_time
        invalidate_find_cache
        @runtime.call('__csimUnselectOption', handle)
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

      def status_code      = 200
      def response_headers = {}

      # Driver surface bits that v2 Browser exposes; stubbed for v3 PoC.
      def set_header(name, value)         ; @sticky_headers[name.to_s] = value.to_s ; end
      def set_viewport(*)                 ; nil ; end
      def viewport_width                  ; 1024 ; end
      def viewport_height                 ; 768 ; end
      def go_back                         ; nil ; end
      def go_forward                      ; nil ; end
      def active_element_handle           ; nil ; end
      def session_send_keys(_)            ; nil ; end
      def with_modal(_)                   ; yield ; end
      def start_trace(_)                  ; nil ; end
      def trace                           ; nil ; end
      def pending_trace                   ; nil ; end
      def clear_trace!                    ; nil ; end
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
      def evaluate_async_script(_, _ = []); nil ; end

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
        # Doing it outside the @ticking guard means the navigate's own
        # rebuild_ctx is well-clear of the V8 call we just made.
        consume_pending_location
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
        body    = URI.encode_www_form(fields)
        action_url = action.empty? ? (@current_url || DEFAULT_HOST) : resolve_against_current(action)
        if method == 'GET'
          uri = URI.parse(action_url)
          uri.query = body unless body.empty?
          navigate(uri.to_s)
        else
          navigate_post(action_url, body, spec['enctype'].to_s)
        end
      end

      def navigate_post(url, body, content_type, depth: 0)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
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
        @last_request = {method: :post, url: url, body: body, content_type: content_type}
        html         = read_rack_body(resp_body)
        # Same rebuild-on-full-load contract as `navigate`. POST
        # responses (form submissions that don't redirect, AJAX-less
        # data-remote replies) replace the page; we follow real-browser
        # semantics and bring up a fresh VM rather than papering over
        # the previous one's state.
        @runtime.rebuild_ctx
        reset_timer_state
        apply_esm_flag
        @runtime.call('__csimUpdateLocation', @current_url.to_s)
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
        @runtime.install_app_snapshot_if_needed
      end

      def reset!
        @cookies.clear
        @sticky_headers.clear
        @current_url     = nil
        @document_handle = 0
        @runtime.reset_page
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

      def rack_fetch(method, url, body, headers, _redirect_mode)
        env = Rack::MockRequest.env_for(url, method: method.to_s.upcase, input: body || '')
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
        @cookies.each {|k, v| env['HTTP_COOKIE'] = "#{env['HTTP_COOKIE']}#{env['HTTP_COOKIE'] ? '; ' : ''}#{k}=#{v}" }
        status, resp_headers, resp_body = @app.call(env)
        body_str = read_rack_body(resp_body)
        {'status' => status, 'headers' => stringify(resp_headers), 'body' => body_str}
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

      # `window.location.assign(url)` / `location.pathname = '/x'` / etc.
      # routes through here from the JS bridge. Real browsers navigate
      # synchronously, but doing so from inside the running V8 call
      # would rebuild the Context mid-call (ScriptTerminatedError). Stash
      # the target and drain after the call returns — same deferred-
      # intent shape we use for `__csimPendingFormSubmit`.
      def location_assign(url)
        @pending_location = resolve_against_current(url.to_s)
      end
      def consume_pending_location
        return unless (url = @pending_location)
        @pending_location = nil
        navigate(url)
      end
      # Replay the last navigation. After a form POST, real browsers
      # re-send the POST (with the usual "Resubmit?" prompt); a
      # GET-after-GET is just a re-GET. `@last_request` captures the
      # method + payload so we can match that contract.
      def refresh
        req = @last_request
        return unless req
        if req[:method] == :post
          navigate_post(req[:url], req[:body], req[:content_type])
        else
          navigate(req[:url])
        end
      end
      def history_state(url)   ; @current_url = url.to_s ; end
      def set_listened_type(*) ; end
      def document_cookie      ; @cookies.map {|k, v| "#{k}=#{v}" }.join('; ') ; end
      def write_document_cookie(s)
        return if s.nil? || s.empty?
        name, rest = s.split('=', 2)
        @cookies[name] = (rest || '').split(';', 2).first.to_s
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
      def navigate(url, depth: 0, referer: @current_url)
        raise 'too many redirects' if depth > 10
        invalidate_find_cache
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_COOKIE']   = document_cookie unless @cookies.empty?
        env['HTTP_REFERER']  = referer         unless referer.nil? || referer.empty?
        @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        status, headers, body = @app.call(env)
        merge_set_cookie(headers)
        if (300..399).include?(status) && headers['location']
          next_url = resolve_against_current(headers['location'])
          body.close if body.respond_to?(:close)
          return navigate(next_url, depth: depth + 1)
        end
        if download_response?(headers)
          save_downloaded_response(url, headers, body)
          return
        end
        @current_url = url
        @last_request = {method: :get, url: url}
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
        @runtime.call('__csimUpdateLocation', @current_url.to_s)
        # `__csimLoadDocument` walks importmaps + module scripts during
        # `runInlineScripts`. The JS bridge pushes the importmap back
        # to Ruby via `__csim_pushImportmap` before any module loads,
        # so `load_module` sees the fully-merged map.
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
        # First-visit only: harvest external script bodies that just
        # got evaluated and promote the runtime onto an app-warm
        # snapshot. Subsequent visits skip library re-eval; the
        # snapshot already has them.
        @runtime.install_app_snapshot_if_needed
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

      # Honour `Capybara.save_path` when set so tests using the Capybara
      # download contract (`Capybara.save_path/<filename>`) find the
      # file we wrote. `CSIM_DOWNLOADS_DIR` is the explicit override;
      # `tmp/downloads/` is the legacy fallback for vs-world apps.
      def downloads_directory
        ENV['CSIM_DOWNLOADS_DIR'] || Capybara.save_path || File.join(Dir.pwd, 'tmp', 'downloads')
      end

      def merge_set_cookie(headers)
        sc = headers['set-cookie'] || headers['Set-Cookie']
        return unless sc
        Array(sc).each {|c|
          name, rest = c.split(';', 2).first.to_s.split('=', 2)
          @cookies[name] = rest.to_s if name && !name.empty?
        }
      end

      def stringify(headers)
        out = {}
        headers.each {|k, v| out[k.to_s] = v.is_a?(Array) ? v.join(',') : v.to_s }
        out
      end

      def resolve_against_current(url)
        return url if url =~ %r{\A[a-z]+://}i
        require 'uri'
        base = @current_url || DEFAULT_HOST
        URI.join(base, url.to_s).to_s
      rescue URI::InvalidURIError
        url
      end
    end
  end
end
