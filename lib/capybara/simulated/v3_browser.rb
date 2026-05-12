# frozen_string_literal: true

# v3 PoC Browser. Standalone — does *not* inherit from the v2
# `Browser` because the whole point of v3 is to drop the Nokogiri
# tree and its accumulated machinery. Subset of `Browser`'s surface
# wired up so a `Capybara::Session` can `visit` and `find` against
# the V8-resident DOM. Milestones 3+ grow this incrementally.

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
        @document_handle              = 0
        @last_tick_ts                 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @polling_until                = nil
        @ticking                      = false
        @modal_handlers               = []
        @module_cache                 = {}
        # ESM loading is correct on the wire — `<script type="module">`
        # tags fetch, EsmRewriter rewrites, Stimulus boots. But on
        # Redmine the same load order causes the legacy
        # `$(document).ready` chain to register
        # `addFormObserversForDoubleSubmit` twice, which then
        # preventDefaults every form submission. `CSIM_V3_ESM=1` opts
        # into the new path; default stays at "skip modules" so the
        # Redmine 11/122 baseline is preserved while the regression
        # is untangled.
        @runtime.eval('globalThis.__csim_esm_enabled = ' + (ENV['CSIM_V3_ESM'] == '1').to_s)
      end

      # ── Capybara DSL surface (just enough for milestone 2) ──────

      def visit(url)
        navigate(resolve_against_current(url))
      end

      def current_url
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
      def find_css(css, context_handle = nil)
        tick_real_time
        s = css.to_s
        if xpath_shaped?(s)
          return find_xpath(s, context_handle)
        end
        begin
          # When scoped, emit context-relative XPath (`.//`) so wgxpath
          # honors the context node. Without the prefix Nokogiri returns
          # `//` (descendant-of-root) which ignores `context_handle` and
          # collects matches across the whole document — surfaced as
          # `Capybara::Ambiguous` whenever a within() block expected one
          # element (e.g. Redmine's ReactionsSystemTest scoped to a span).
          prefix = context_handle ? './/' : '//'
          xpath = Nokogiri::CSS.xpath_for(s, prefix: prefix).first
          return find_xpath(xpath, context_handle) if xpath
        rescue Nokogiri::CSS::SyntaxError, StandardError
          # Fall back to the JS-side parser. Worth trying because
          # `xpath_for` can choke on Capybara-emitted pseudo selectors
          # (`:not(...)`, attribute case-insensitive flags) that our
          # JS path either supports or ignores predictably.
        end
        @runtime.call('__csimQuery', context_handle || @document_handle, s).to_a
      end

      def find_first_css(css, context_handle = nil)
        tick_real_time
        h = @runtime.call('__csimQueryOne', context_handle || @document_handle, css.to_s).to_i
        h.zero? ? nil : h
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
        if XPATH_BACKEND == :nokogiri
          find_xpath_via_nokogiri(xpath, context_handle)
        else
          @runtime.call('__csimEvaluateXPath', xpath.to_s, context_handle || 0).to_a
        end
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
      def visible?(handle)    = @runtime.call('__csimVisible', handle) ? true : false

      # Capybara::Driver::Node surface ----------------------------------
      #
      # PoC: text == all_text == visible_text. Cascade-driven visibility
      # filtering is deferred (V3_DESIGN.md milestone 5+).
      def all_text(handle)     = text(handle)
      def visible_text(handle) = @runtime.call('__csimVisibleText', handle).to_s
      def tag_name(handle)     = tag(handle)
      def value(handle)        = @runtime.call('__csimValue', handle)
      def disabled?(handle)    = @runtime.call('__csimDisabled', handle)
      def option_selected?(h)  = !!attr(h, 'selected')
      def shadow_root_handle(_) = nil
      def computed_style(_, names) = names.to_h {|n| [n, ''] }
      def node_path(_)         = ''

      def lookup_node(handle)
        handle if @runtime.call('__csimAlive', handle)
      end

      def check_stale(handle, initial)
        return if initial && @runtime.call('__csimAlive', handle)
        raise Capybara::Simulated::StaleElement, "Element with handle #{handle} is no longer attached to the document"
      end

      # PoC click: anchors with href navigate; submit buttons trigger a
      # form submission through the Rack app. Checkbox / radio toggle
      # inline on the JS side (no Ruby trip). Everything else is a
      # no-op until milestone 4 lands event dispatch.
      def click(handle, _keys = [], **_opts)
        tick_real_time
        action = @runtime.call('__csimClickResolve', handle)
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
        end
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
        # File inputs may receive a single Pathname (most attach_file
        # calls); promote to the file-list path so .files / @file_picks
        # see it as one-element array.
        coerced = [coerced.to_s] if value.is_a?(Pathname)
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

      def right_click(handle, *_)
        tick_real_time
        @runtime.call('__csimDispatchEvent', handle, 'contextmenu', {'bubbles' => true, 'cancelable' => true})
      end

      def double_click(handle, *_)
        tick_real_time
        @runtime.call('__csimDispatchEvent', handle, 'dblclick', {'bubbles' => true, 'cancelable' => true})
      end

      def hover(handle)
        tick_real_time
        @runtime.call('__csimDispatchEvent', handle, 'mouseover', {'bubbles' => true, 'cancelable' => true})
        @runtime.call('__csimDispatchEvent', handle, 'mouseenter', {'bubbles' => false, 'cancelable' => false})
      end

      def dispatch_event(handle, type, init = {})
        tick_real_time
        @runtime.call('__csimDispatchEvent', handle, type.to_s, init)
      end

      # Capybara's `send_keys` accepts Strings and Symbols (special
      # keys: `:enter`, `:tab`, `:backspace`, …) and Array combos
      # (modifier + key). PoC: append printable keys to the input's
      # value and fire input/change. Special keys + modifier combos
      # land later — for now, special keys without a known glyph are
      # dropped.
      def send_keys(handle, keys)
        tick_real_time
        text = keys.flat_map {|k|
          case k
          when String then [k]
          when Symbol then [SEND_KEYS_GLYPHS[k]].compact
          when Array  then k.map {|x| x.is_a?(String) ? x : SEND_KEYS_GLYPHS[x] }.compact
          else []
          end
        }.join
        @runtime.call('__csimSendKeys', handle, text)
      end

      SEND_KEYS_GLYPHS = {
        space: ' ',
        tab:   "\t",
        enter: "\n",
        return: "\n"
      }.freeze

      def select_option(handle)
        tick_real_time
        @runtime.call('__csimSelectOption', handle)
      end

      def unselect_option(handle)
        tick_real_time
        @runtime.call('__csimUnselectOption', handle)
      end

      # `Node#submit(*)` (Capybara DSL) hits here. Find the enclosing
      # form, serialise, post.
      def submit_form(handle)
        tick_real_time
        form_handle = @runtime.call('__csimAncestorForm', handle).to_i
        return if form_handle.zero?
        submit_form_handle(form_handle, nil)
      end

      def title
        @runtime.call('__csimDocumentTitle').to_s
      end

      def html
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
        now      = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        elapsed  = ((now - @last_tick_ts) * 1000).to_i
        @last_tick_ts = now
        step = [[elapsed, TICK_MIN_MS].max, TICK_CAP_MS].min
        @runtime.drain_timers(step) if step > 0
      ensure
        @ticking = false
      end

      # Pulls the serialised form-state out of JS, encodes it, and
      # drives the Rack app via `navigate` (for GET) or a POST. Mirrors
      # the slice of <form> semantics rack-test supports — multipart
      # uploads lift in with milestone 4+ once <input type=file> matters.
      def submit_form_handle(form_handle, submitter_handle)
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
        @current_url = url
        html         = read_rack_body(resp_body)
        # Same rebuild-on-full-load contract as `navigate`. POST
        # responses (form submissions that don't redirect, AJAX-less
        # data-remote replies) replace the page; we follow real-browser
        # semantics and bring up a fresh VM rather than papering over
        # the previous one's state.
        @runtime.rebuild_ctx
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
      end

      # ── Host-fn callbacks invoked by v3_bridge.js ───────────────

      # JS-side loader callback: hand back the raw module body for `url`.
      # The runtime then runs `EsmRewriter.rewrite` on it. Cached per
      # Browser instance so concurrent re-evals don't re-fetch.
      # Inline modules are pre-registered via the JS-side
      # `__csim_inlineSources` map, indexed by hashed-body URL —
      # we surface them here so the same module cache covers both
      # paths.
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
        @module_cache[url] = rewrite_module_imports(body, url)
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
      def set_importmap(json)
        @importmap = JSON.parse(json.to_s)
      rescue JSON::ParserError
        @importmap = {'imports' => {}, 'scopes' => {}}
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
        (headers || {}).each {|k, v| env["HTTP_#{k.to_s.upcase.tr('-', '_')}"] = v }
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

      def location_assign(url) ; navigate(resolve_against_current(url.to_s)) ; end
      def refresh              ; navigate(@current_url) if @current_url ; end
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
      def navigate(url, depth: 0)
        raise 'too many redirects' if depth > 10
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_COOKIE']   = document_cookie unless @cookies.empty?
        env['HTTP_REFERER']  = @current_url    unless @current_url.nil? || @current_url.empty?
        @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        status, headers, body = @app.call(env)
        merge_set_cookie(headers)
        if (300..399).include?(status) && headers['location']
          next_url = resolve_against_current(headers['location'])
          body.close if body.respond_to?(:close)
          return navigate(next_url, depth: depth + 1)
        end
        @current_url = url
        html         = read_rack_body(body)
        @module_cache = {}
        @importmap    = {'imports' => {}, 'scopes' => {}}
        # Full-reload navigation rebuilds the JS Context from the warm
        # snapshot. Mirrors v2's pool-checkout model: per-visit fresh VM
        # avoids the partial-reset drift (jQuery `.ready`, rails-ujs
        # `_rails_loaded`, accumulated `$(document).on(...)` delegates)
        # that bit us when state leaked between visits. Snapshot warmup
        # keeps the rebuild cost at a few ms; the cost dominator is
        # re-evaluating app bundles, which is what we want.
        @runtime.rebuild_ctx
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
