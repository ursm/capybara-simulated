require 'date'
require 'digest'
require 'json'
require 'mini_racer'
require 'open3'
require 'rack/mock'
require 'securerandom'
require 'time'
require 'uri'

module Capybara
  module Simulated
    class Browser
      VENDOR_DIR   = File.expand_path('../../../../vendor/js', __FILE__)
      DEFAULT_HOST = 'http://www.example.com'.freeze

      # The V8 isolate is shared across the lifetime of a Browser instance —
      # only the happy-dom Window is recreated per visit. Reset between
      # specs is via `reset!` on the Driver, which closes the Window and
      # clears tracked DOM handles, but keeps the (expensive) isolate alive.
      # On mini_racer + happy-dom the previously-denylisted scripts (notably
      # jQuery UI) load without hanging the runtime, and ready callbacks
      # depend on them succeeding so we no longer skip anything by default.
      EXTERNAL_SCRIPT_DENYLIST = /\A\z/.freeze

      attr_reader :app, :status_code, :response_headers

      # window.history.pushState/replaceState only updates the JS-side
      # location; mirror it onto the Ruby @current_url so Capybara reads
      # the new path. Before any real visit (or after reset_session!), we
      # have no @current_url, in which case we report `nil` rather than
      # leaking the synthetic happy-dom Window URL.
      def current_url
        return '' unless @current_url
        # Capybara's synchronize loop calls current_path/current_url while
        # waiting for navigation. Drive the virtual clock so timer-based
        # location updates (window.location.pathname = '...') eventually
        # fire under the wait budget.
        advance_virtual_clock
        check_location_change unless @in_navigate
        loc = (@ctx.eval('window && window.location ? window.location.href : null') rescue nil)
        loc && !loc.empty? ? loc.to_s : @current_url
      end
      attr_accessor :driver_for_results

      def initialize(app)
        @app = app
        @ctx = MiniRacer::Context.new
        @ctx.eval(File.read(File.join(VENDOR_DIR, 'prelude.js')))
        @ctx.eval(File.read(File.join(VENDOR_DIR, 'csim.bundle.js')))
        @ctx.eval(File.read(File.join(VENDOR_DIR, 'runtime.js')))
        @ctx.attach('__csim_fetch', method(:js_fetch))

        @history          = []
        @history_index    = -1
        @current_url      = nil
        @status_code      = nil
        @response_headers = {}
        @modal_responses  = {alert: [], confirm: [], prompt: []}
        @cookie_jar       = []
      end

      # Tear down all per-page state without throwing away the V8 isolate.
      # Capybara calls this between specs via Driver#reset!.
      def reset_state!
        @history          = []
        @history_index    = -1
        @current_url      = nil
        @status_code      = nil
        @response_headers = {}
        @modal_responses  = {alert: [], confirm: [], prompt: []}
        @last_call_at     = nil
        @cookie_jar       = []
        # `loadHTML` clears all tracked node handles and recreates the
        # happy-dom Window for an empty document.
        call_runtime('loadHTML', '<!doctype html><html><body></body></html>', DEFAULT_HOST)
        call_runtime('setModalResponses', stringify_keys(@modal_responses))
      end

      # Explicit `visit` is a new navigation, not a follow-up — drop the
      # referer the way browsers' address-bar navigation does, and resolve
      # the URL against the configured app host rather than the current
      # page (which may have a stale `<base href>`).
      def visit(url)
        navigate(:get, resolve_visit_url(url), [], referer: false)
      end

      def resolve_visit_url(url)
        return @current_url if !url.nil? && !url.empty? && @current_url && url == @current_url
        url = '/' if url.nil? || url.empty?
        return url if url.start_with?('http://', 'https://')
        # Resolve relative paths against the app host's root (not the
        # currently displayed page), matching Capybara's `visit` semantics
        # for rack_test-style drivers.
        host = Capybara.app_host
        if host.nil?
          uri = URI.parse(@current_url || DEFAULT_HOST)
          host = "#{uri.scheme}://#{uri.host}#{uri.port ? ":#{uri.port}" : ''}/"
        end
        URI.join(host, url).to_s
      end
      def refresh
        return unless @current_url
        # Browsers re-issue the previous request as-is on F5 (after a
        # confirmation prompt for non-GETs, which our driver skips).
        method = @last_method || :get
        navigate(method, @current_url, @last_fields || [],
                 enctype: @last_enctype || 'application/x-www-form-urlencoded',
                 replace_history: true)
      end
      def go_back
        return if @history_index <= 0
        @history_index -= 1
        navigate(:get, @history[@history_index], [], history_move: true)
      end
      def go_forward
        return if @history_index >= @history.size - 1
        @history_index += 1
        navigate(:get, @history[@history_index], [], history_move: true)
      end

      def html  = call_runtime('html')
      def title = call_runtime('title')

      def find_xpath(xpath, context_id = nil) = Array(call_runtime('findXPath', xpath, context_id))
      def find_css(css, context_id = nil)     = Array(call_runtime('findCSS', css, context_id))

      def all_text(id)     = call_runtime('allText', id).to_s
      def visible_text(id) = call_runtime('visibleText', id).to_s
      def inner_html(id)   = call_runtime('innerHTML', id).to_s
      def outer_html(id)   = call_runtime('outerHTML', id).to_s
      def tag_name(id)     = call_runtime('tagName', id).to_s
      def attr(id, name)   = call_runtime('attr', id, name.to_s)
      def prop(id, name)   = call_runtime('prop', id, name.to_s)
      def value(id)        = call_runtime('value', id)
      def visible?(id)     = !!call_runtime('visible', id)
      def checked?(id)     = !!call_runtime('checked', id)
      def selected?(id)    = !!call_runtime('selected', id)
      def disabled?(id)    = !!call_runtime('disabled', id)
      def readonly?(id)    = !!call_runtime('readonly', id)
      def multiple?(id)    = !!call_runtime('multiple', id)
      def path(id)         = call_runtime('path', id).to_s
      def rect(id)         = call_runtime('rect', id) || {}

      def set_value(id, value)
        # setValue may return a submit-descriptor when the user typed `\n`
        # into the only text input of a form (HTML implicit submission).
        result = call_runtime('setValue', id, format_set_value(value))
        follow(result) if result.is_a?(Hash) && result['action']
        result
      end

      # Capybara hands Date/DateTime/Time objects through to the driver as-is
      # but mini_racer can't serialise them. Pre-format them to the strings
      # an HTML5 input expects so they round-trip via JS.
      def format_set_value(value)
        case value
        when Array      then value.map {|v| format_set_value(v) }
        when Date       then value.strftime('%Y-%m-%d')
        when DateTime   then value.strftime('%Y-%m-%dT%H:%M')
        when Time       then value.strftime('%Y-%m-%dT%H:%M')
        else                 value
        end
      end
      def select_option(id)    = call_runtime('selectOption', id)
      def unselect_option(id)  = call_runtime('unselectOption', id)

      def click(id, modifiers = {})
        delay = modifiers.delete('delay')
        if delay&.positive?
          call_runtime('mouseDown', id, 0, modifiers)
          sleep(delay)
          result = follow(call_runtime('click', id, 0, modifiers, true))
        else
          result = follow(call_runtime('click', id, 0, modifiers))
        end
        drain_async_timers
        result
      end
      def right_click(id, modifiers = {})
        delay = modifiers.delete('delay')
        if delay&.positive?
          call_runtime('mouseDown', id, 2, modifiers)
          sleep(delay)
          call_runtime('rightClick', id, modifiers, true)
        else
          call_runtime('rightClick', id, modifiers)
        end
        drain_async_timers
      end
      def double_click(id, modifiers = {})
        result = call_runtime('doubleClick', id, modifiers)
        drain_async_timers
        result
      end
      def hover(id)
        call_runtime('hover', id).tap { drain_async_timers }
      end
      def trigger(id, evt)
        call_runtime('trigger', id, evt.to_s).tap { drain_async_timers }
      end
      def focus(id)        = call_runtime('focus', id)
      def blur(id)         = call_runtime('blur', id)
      def active_element   = call_runtime('activeElement')

      def drop(id, items)
        call_runtime('drop', id, items).tap { drain_async_timers }
      end

      def submit(id)
        result = follow(call_runtime('submit', id))
        drain_async_timers
        result
      end

      def shadow_root(id) = call_runtime('shadowRoot', id)

      def send_keys(id, keys)
        directive = call_runtime('sendKeys', id, encode_keys(keys))
        follow(directive)
      end

      def execute_script(code, args = [])
        call_runtime('executeScript', code.to_s, encode_script_args(args))
        nil
      end
      def evaluate_script(code, args = [])
        decode_script_result(call_runtime('evaluate', code.to_s, encode_script_args(args)))
      end

      # Capybara's async-script contract: the user script receives a
      # callback as its final `arguments[N]` and must invoke it (possibly
      # after a setTimeout) with the result. We have no real event loop,
      # so after kicking the script off we drive the virtual clock in
      # small slices until the callback fires or the wait budget is up.
      ASYNC_POLL_STEP_MS = 50
      def evaluate_async_script(code, args = [])
        call_runtime('startAsync', code.to_s, encode_script_args(args))
        budget = (Capybara.default_max_wait_time || 2).to_f
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + budget
        loop do
          status = @ctx.call('__csim.pollAsync')
          if status['done']
            raise MiniRacer::RuntimeError, status['error'] if status['error']
            return decode_script_result(status['value'])
          end
          break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
          @ctx.call('__csim.drainTimers', ASYNC_POLL_STEP_MS) rescue nil
        end
        raise Capybara::ScriptTimeoutError, 'evaluate_async_script timed out'
      end

      def set_modal_responses(alerts: [], confirms: [], prompts: [])
        @modal_responses = {alert: Array(alerts), confirm: Array(confirms), prompt: Array(prompts)}
        call_runtime('setModalResponses', stringify_keys(@modal_responses))
      end

      # Append a text-matched handler used by `accept_modal` /
      # `dismiss_modal`. JS-side modal stubs scan the handler stack in
      # registration order and pick the first whose text predicate
      # matches the firing message — which is what enables nested
      # `dismiss_confirm { accept_confirm { ... } }`.
      def add_modal_handler(type:, text: nil, response: true)
        encoded = encode_modal_handler(type, text, response)
        call_runtime('pushModalHandler', encoded)
      end

      def remove_modal_handler(type:, text: nil)
        call_runtime('popModalHandler', type.to_s, encode_modal_text(text))
      end

      def encode_modal_handler(type, text, response)
        {
          'type'     => type.to_s,
          'text'     => encode_modal_text(text),
          'response' => response.is_a?(Symbol) ? response.to_s : response
        }
      end

      def encode_modal_text(text)
        case text
        when nil      then nil
        when Regexp   then {'regexp' => text.source, 'flags' => text.options}
        else               text.to_s
        end
      end
      def drain_modal_queue
        captured = @captured_modals
        @captured_modals = nil
        out = Array(call_runtime('drainModalQueue'))
        captured ? captured + out : out
      end

      # Long-lived inbox shared by nested `accept_modal` /
      # `dismiss_modal` blocks. Each driver call drains the JS-side queue
      # once and stashes unmatched modals here so the OUTER block can
      # still find its message after the inner one consumes its own.
      def modal_inbox
        @modal_inbox ||= []
      end

      # Snapshot the JS-side modalQueue before a navigate wipes it, so a
      # subsequent `drain_modal_queue` still sees alerts that fired
      # synchronously from inside the click handler.
      def capture_pending_modals
        pending = Array(@ctx.call('__csim.drainModalQueue')) rescue []
        return if pending.empty?
        @captured_modals ||= []
        @captured_modals.concat(pending)
      end

      # Forced advance for callers (e.g. accept_modal) that need to age
      # out async setTimeout-driven side effects without waiting on the
      # wall-clock heuristic in advance_virtual_clock.
      def advance_virtual_clock_step(ms)
        @ctx.call('__csim.drainTimers', ms.to_i) rescue nil
      end

      private

      # Pump only zero-delay timers (microtask-style fallouts of jQuery's
      # `$(fn)` and similar). Any non-zero setTimeout queued during the
      # interaction stays pending — Capybara's synchronize loop will
      # advance the virtual clock as it retries.
      # After interaction events that may kick off Turbo / Stimulus async
      # rendering, drain enough virtual-clock to flush a `requestAnimationFrame`
      # (which our prelude maps to `setTimeout(..., 16)`) plus any chained
      # microtasks. Without this, `<turbo-stream>`'s async `connectedCallback`
      # leaves the DOM mid-render until the next call advances the clock.
      DRAIN_AFTER_INTERACTION_MS = 32
      def drain_async_timers
        @ctx.call('__csim.drainTimers', DRAIN_AFTER_INTERACTION_MS) rescue nil
      end

      def advance_virtual_clock
        now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        if @last_call_at
          ms = ((now - @last_call_at) * 1000).to_i
          @ctx.call('__csim.drainTimers', ms) rescue nil if ms.positive?
        end
        @last_call_at = now
      end

      # Per call_runtime, mirror real wall-clock progress into the JS
      # virtual clock so setTimeout-style handlers fire as Capybara's
      # synchronize loop ages out the wait budget. Skip the bookkeeping
      # for the calls that should never trigger user code (timer drain,
      # page load setup, modal-response wiring).
      VIRTUAL_TICKLESS = %w[drainTimers loadHTML setModalResponses].freeze

      def call_runtime(method, *args)
        advance_virtual_clock unless VIRTUAL_TICKLESS.include?(method)
        result = @ctx.call("__csim.#{method}", *args)
        # Skip the implicit-navigation pickup when the runtime returned a
        # navigation directive: `follow` will run the actual visit through
        # Rack with the right method/body, and we don't want to clobber it
        # with a GET driven by happy-dom's stale window.location update.
        if !VIRTUAL_TICKLESS.include?(method) && !@in_navigate &&
           !(result.is_a?(Hash) && %w[navigate submit].include?(result['action']))
          check_location_change
        end
        result
      rescue MiniRacer::RuntimeError => e
        if e.message.to_s.include?('stale or unknown node handle')
          raise Capybara::Simulated::StaleElementReferenceError, e.message
        end
        raise
      end

      # Detect when user JS assigned to window.location and trigger an
      # actual visit through the Rack stack so subsequent finds operate
      # on the new page.
      def check_location_change
        return unless @current_url
        loc = (@ctx.eval('window && window.location ? window.location.href : null') rescue nil)
        return unless loc.is_a?(String) && !loc.empty?
        return if loc == @current_url
        # history.pushState / replaceState changed the URL but did not
        # trigger a fetch — adopt the new URL without re-fetching.
        if (@ctx.call('__csim.consumeHistoryPushed') rescue false)
          @current_url = loc
          return
        end
        a = URI.parse(@current_url) rescue nil
        b = URI.parse(loc) rescue nil
        return unless a && b
        # Same scheme/host/path/query → only the fragment changed; no fetch.
        if a.scheme == b.scheme && a.host == b.host && a.port == b.port &&
           a.path == b.path && a.query == b.query
          @current_url = loc
          return
        end
        # Trigger a real navigation under the Rack app.
        navigate(:get, loc, [], referer: @current_url)
      end

      def follow(directive)
        return nil unless directive.is_a?(Hash)
        # Snapshot any modal recorded by the click handler before the
        # navigate clears the JS-side queue (loadHTML resets state).
        # Capybara's `accept_alert { click_link 'Alert page change' }`
        # otherwise loses the alert message because it fires synchronously
        # from the same click that triggers the navigation.
        capture_pending_modals if %w[navigate submit].include?(directive['action'])
        case directive['action']
        when 'navigate'
          target = resolve_url(directive['href'])
          # `<a href="/foo#bar">` from the same /foo page is just an
          # in-page anchor jump in real browsers — no request, no reload.
          if @current_url && same_path_anchor?(@current_url, target)
            @current_url = target
            return nil
          end
          navigate(:get, target)
        when 'submit'
          method = (directive['method'] || 'GET').downcase.to_sym
          target = directive['url'].to_s.empty? ? @current_url : directive['url']
          navigate(method, resolve_url(target), directive['fields'] || [], enctype: directive['enctype'])
        end
      end

      def navigate(method, url, fields = [], enctype: 'application/x-www-form-urlencoded',
                   replace_history: false, history_move: false, referer: nil)
        # Avoid recursive location-change detection while we're in the
        # middle of installing the new page.
        outermost = !@in_navigate
        @in_navigate = true
        full_url = resolve_url(url)
        body = nil
        env_overrides = {}

        if %i[post put patch delete].include?(method)
          if enctype.to_s.start_with?('multipart/form-data')
            boundary = "----CapybaraSimulatedBoundary#{SecureRandom.hex(8)}"
            body = build_multipart_body(fields, boundary)
            env_overrides['CONTENT_TYPE'] = "multipart/form-data; boundary=#{boundary}"
          elsif fields.any? { |_, v| v.is_a?(Hash) && v['file'] }
            # Non-multipart form with a file input: real browsers submit
            # the file's basename as the field value.
            cleaned = fields.flat_map do |k, v|
              if v.is_a?(Hash) && v['file']
                paths = Array(v['paths'])
                paths.empty? ? [[k, '']] : paths.map { |p| [k, File.basename(p.to_s)] }
              else
                [[k, v]]
              end
            end
            body = URI.encode_www_form(cleaned)
            env_overrides['CONTENT_TYPE'] = 'application/x-www-form-urlencoded'
          else
            body = URI.encode_www_form(fields)
            env_overrides['CONTENT_TYPE'] = enctype
          end
        elsif fields.any?
          uri = URI.parse(full_url)
          uri.query = [uri.query.to_s, URI.encode_www_form(fields)].reject(&:empty?).join('&')
          full_url = uri.to_s
        end

        ref = referer.nil? ? @current_url : (referer || nil)
        env_overrides['HTTP_REFERER'] = ref if ref

        cookie_header = build_cookie_header(full_url)
        env_overrides['HTTP_COOKIE'] = cookie_header unless cookie_header.empty?

        request  = Rack::MockRequest.new(@app)
        response = request.request(method.to_s.upcase, full_url, env_overrides.merge(input: body || ''))

        ingest_set_cookie(response.headers, full_url)

        @current_url      = full_url
        @status_code      = response.status
        @response_headers = response.headers
        @last_method      = method
        @last_fields      = fields
        @last_enctype     = enctype

        unless history_move
          if replace_history
            @history[@history_index] = full_url if @history_index >= 0
            @history[@history_index] = full_url if @history_index < 0
            @history_index = 0 if @history_index < 0
          else
            @history = @history[0..@history_index] + [full_url]
            @history_index = @history.size - 1
          end
        end

        if (300..399).cover?(response.status) && response.headers['location']
          # Preserve the original fragment across redirects when the target
          # location does not include one — browsers do this per RFC 7231.
          target = response.headers['location']
          orig_frag = URI.parse(full_url).fragment rescue nil
          if orig_frag && !orig_frag.empty?
            tgt = URI.parse(target) rescue nil
            target = "#{target}##{orig_frag}" if tgt && (tgt.fragment.nil? || tgt.fragment.empty?)
          end
          if [307, 308].include?(response.status)
            return navigate(method, target, fields, enctype: enctype, referer: ref)
          end
          return navigate(:get, target, referer: ref)
        end

        load_html(response.body)
      ensure
        @in_navigate = false if outermost
      end

      def load_html(html)
        # loadHTML rebuilds the happy-dom Window with @current_url so
        # window.location matches Ruby's view of the page after a real
        # navigation.
        call_runtime('loadHTML', wrap_fragment_html(html.to_s), @current_url.to_s)
        call_runtime('setModalResponses', stringify_keys(@modal_responses))
        load_external_scripts
        call_runtime('runInlineScripts')
        load_module_scripts
        call_runtime('syncWindowGlobals')
        # Drain only the immediate (zero-delay) timers queued during page
        # load — typically jQuery's `$(fn)` ready callbacks. Anything
        # genuinely delayed waits for the synchronize loop to age it in.
        call_runtime('drainTimers', 0)
        @last_call_at = nil
        nil
      end

      # Rails apps pin module dependencies via `<script type="importmap">`
      # and load them via `<script type="module">`. mini_racer has no ESM
      # loader, so we shell out to esbuild (via vendor/js/bundle-modules.mjs)
      # to compile the entire dependency graph into a single IIFE bundle
      # that runs in the same isolate as inline scripts. Pre-fetches every
      # reachable module through Rack so the bundler never makes a real
      # network call.
      MODULE_BUNDLER_SCRIPT = File.join(VENDOR_DIR, 'bundle-modules.mjs').freeze
      MODULE_IMPORT_RX = /(?:^|[\s;{(=])(?:import|export)(?:\s*\(|[^'"\n;]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/m.freeze

      def load_module_scripts
        details = call_runtime('moduleScriptDetails')
        return if details.nil?
        importmap = parse_importmap_from_details(details)
        entries   = Array(details['entries'])
        return if importmap.empty? && entries.empty?

        cache_key = Digest::SHA256.hexdigest(JSON.dump([importmap, entries, @current_url]))
        @module_bundle_cache ||= {}
        bundle = @module_bundle_cache[cache_key] ||=
                 build_module_bundle(importmap, entries)
        return unless bundle
        @ctx.eval(bundle)
        # Resolve any dynamic imports queued during the bundle's static
        # evaluation phase. The registry is populated only after the
        # bundle body runs, so deferred resolution is the only way to
        # honour `import("controllers/foo")` calls fired by code like
        # stimulus-loading's eagerLoad.
        @ctx.eval('typeof __csim_drain_imports === "function" && __csim_drain_imports()')
        call_runtime('syncWindowGlobals')
      end

      def parse_importmap_from_details(details)
        raw = details['importmap']
        return {} if raw.nil? || raw.to_s.strip.empty?
        JSON.parse(raw)
      rescue JSON::ParserError
        {}
      end

      def build_module_bundle(importmap, entries)
        sources = prefetch_module_sources(importmap, entries)
        payload = JSON.dump(
          'importmap' => importmap,
          'baseUrl'   => @current_url || DEFAULT_HOST,
          'entries'   => entries,
          'sources'   => sources
        )
        out, err, status = Open3.capture3('node', MODULE_BUNDLER_SCRIPT, stdin_data: payload)
        unless status.success?
          warn "[capybara-simulated] module bundler failed: #{err.to_s[0, 400]}"
          return nil
        end
        out
      end

      # Walk the module graph by fetching each entry/import via Rack and
      # extracting nested `import`/`export ... from` references with a
      # regex. We don't try to be clever about live-binding semantics —
      # esbuild handles that. We just need every reachable URL in the
      # `sources` map before the bundler runs.
      def prefetch_module_sources(importmap, entries)
        base = @current_url || DEFAULT_HOST
        seen = {}
        queue = []
        entries.each do |e|
          if (src = e['src'] || e[:src])
            url = resolve_module_specifier(src, base, importmap, base)
            queue << url if url
          elsif (inline = e['inline'] || e[:inline])
            extract_module_specifiers(inline.to_s).each do |spec|
              url = resolve_module_specifier(spec, base, importmap, base)
              queue << url if url
            end
          end
        end
        # Pre-fetch every importmap pin too, even if no static import
        # reaches it. The bundler statically embeds them all so dynamic
        # `import("controllers/foo_controller")` calls (rewritten to a
        # synchronous registry lookup) resolve at runtime.
        (importmap['imports'] || importmap[:imports] || {}).each do |spec, _|
          next if spec.to_s.end_with?('/')
          url = resolve_module_specifier(spec.to_s, base, importmap, base)
          queue << url if url
        end
        until queue.empty?
          url = queue.shift
          next if seen.key?(url)
          body = fetch_resource(url)
          # Rack hands us ASCII-8BIT strings; the bundler's JSON.dump
          # trips a "UTF-8 string passed as BINARY" warning under json 2.x
          # (and is a hard error in json 3). JS source is always Unicode,
          # so retag without copying bytes.
          body = body.dup.force_encoding(Encoding::UTF_8) if body
          seen[url] = body || ''
          next if body.nil? || body.empty?
          extract_module_specifiers(body).each do |spec|
            next_url = resolve_module_specifier(spec, url, importmap, base)
            queue << next_url if next_url && !seen.key?(next_url)
          end
        end
        seen
      end

      def extract_module_specifiers(source)
        source.to_s.scan(MODULE_IMPORT_RX).flatten.compact
      end

      def resolve_module_specifier(spec, importer, importmap, base)
        return spec if spec.start_with?('http://', 'https://')
        if spec.start_with?('/')
          return URI.join(base, spec).to_s
        end
        if spec.start_with?('./', '../')
          return URI.join(importer, spec).to_s
        end
        imports = (importmap['imports'] || importmap[:imports] || {})
        if imports.key?(spec)
          return resolve_module_specifier(imports[spec], importer, importmap, base)
        end
        # Trailing-slash mapping per the importmap spec.
        match = imports.keys.find {|k| k.end_with?('/') && spec.start_with?(k) }
        if match
          return resolve_module_specifier(imports[match] + spec[match.length..], importer, importmap, base)
        end
        nil
      end

      def load_external_scripts
        srcs = Array(call_runtime('externalScriptSources'))
        srcs.each do |src|
          next if src.nil? || src.empty?
          next if src.match?(EXTERNAL_SCRIPT_DENYLIST)
          body = nil
          begin
            body = fetch_resource(src)
          rescue StandardError => e
            warn "[capybara-simulated] failed to fetch script #{src.inspect}: #{e.class}: #{e.message[0, 120]}"
            next
          end
          next if body.nil?
          begin
            @ctx.eval(body)
            call_runtime('syncWindowGlobals')
          rescue MiniRacer::RuntimeError => e
            warn "[capybara-simulated] script #{src.inspect} raised: #{e.class}: #{e.message[0, 200]}"
          end
        end
      end

      def wrap_fragment_html(html)
        return html if html.empty?
        return html if html.match?(/\A\s*(?:<!doctype\s|<\?xml|<html\b)/i)
        "<!doctype html><html><body>#{html}</body></html>"
      end

      MIME_TYPES = {
        'txt'  => 'text/plain',
        'html' => 'text/html',
        'htm'  => 'text/html',
        'css'  => 'text/css',
        'js'   => 'application/javascript',
        'json' => 'application/json',
        'xml'  => 'application/xml',
        'png'  => 'image/png',
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif'  => 'image/gif',
        'svg'  => 'image/svg+xml',
        'pdf'  => 'application/pdf'
      }.freeze

      def build_multipart_body(fields, boundary)
        parts = []
        fields.each do |name, value|
          if value.is_a?(Hash) && value['file']
            paths = Array(value['paths'])
            if paths.empty?
              parts << multipart_file_part(name, '', '', 'application/octet-stream', boundary)
            else
              paths.each do |path|
                content = File.binread(path) rescue ''
                filename = File.basename(path.to_s)
                ext = File.extname(filename).delete('.').downcase
                ctype = MIME_TYPES[ext] || 'application/octet-stream'
                parts << multipart_file_part(name, content, filename, ctype, boundary)
              end
            end
          else
            parts << multipart_text_part(name, value.to_s, boundary)
          end
        end
        parts.join + "--#{boundary}--\r\n"
      end

      def multipart_text_part(name, value, boundary)
        "--#{boundary}\r\n" \
          "Content-Disposition: form-data; name=\"#{name}\"\r\n\r\n" \
          "#{value}\r\n"
      end

      def multipart_file_part(name, content, filename, ctype, boundary)
        "--#{boundary}\r\n" \
          "Content-Disposition: form-data; name=\"#{name}\"; filename=\"#{filename}\"\r\n" \
          "Content-Type: #{ctype}\r\n\r\n" \
          "#{content}\r\n"
      end

      # ---- minimal cookie jar -------------------------------------------
      # Stores Set-Cookie response headers and replays the matching cookies
      # on subsequent requests. Just enough surface area to satisfy
      # Capybara specs that probe set/clear/path-scoped behaviour.
      def build_cookie_header(url)
        uri = URI.parse(url) rescue nil
        return '' unless uri
        now = Time.now
        @cookie_jar.reject! { |c| c[:expires] && c[:expires] < now }
        matching = @cookie_jar.select do |c|
          domain_matches?(c[:domain], uri.host) && path_matches?(c[:path], uri.path)
        end
        matching.map { |c| "#{c[:name]}=#{c[:value]}" }.join('; ')
      end

      def ingest_set_cookie(headers, url)
        uri = URI.parse(url) rescue nil
        return unless uri
        raw = headers['set-cookie'] || headers['Set-Cookie']
        return unless raw
        Array(raw).each do |line|
          line.to_s.split(/\n/).each {|l| absorb_cookie(l, uri) }
        end
      end

      def absorb_cookie(line, uri)
        parts = line.split(/;\s*/)
        return if parts.empty?
        name, value = parts.shift.split('=', 2)
        return unless name && !name.empty?
        cookie = {
          name:    name.strip,
          value:   (value || '').strip,
          domain:  uri.host,
          path:    '/',
          expires: nil,
          secure:  false,
          http_only: false
        }
        parts.each do |attr|
          k, v = attr.split('=', 2)
          case (k || '').downcase
          when 'domain'   then cookie[:domain] = v.to_s.sub(/\A\./, '')
          when 'path'     then cookie[:path] = v.to_s
          when 'expires'  then cookie[:expires] = (Time.parse(v) rescue nil)
          when 'max-age'
            secs = v.to_i
            cookie[:expires] = Time.now + secs if secs.positive?
            cookie[:expires] = Time.at(0) if secs <= 0
          when 'secure'   then cookie[:secure] = true
          when 'httponly' then cookie[:http_only] = true
          end
        end
        cookie[:path] = '/' if cookie[:path].nil? || cookie[:path].empty?
        # Replace existing cookie with same (name, domain, path).
        @cookie_jar.reject! do |c|
          c[:name] == cookie[:name] && c[:domain] == cookie[:domain] && c[:path] == cookie[:path]
        end
        if cookie[:expires] && cookie[:expires] < Time.now
          # already expired — skip storing
        else
          @cookie_jar << cookie
        end
      end

      def domain_matches?(cookie_domain, host)
        return true if cookie_domain.nil? || cookie_domain.empty?
        return true if cookie_domain == host
        host.to_s.end_with?(".#{cookie_domain}")
      end

      def path_matches?(cookie_path, request_path)
        cookie_path = '/' if cookie_path.nil? || cookie_path.empty?
        return true if cookie_path == '/'
        return true if request_path == cookie_path
        return true if request_path.start_with?(cookie_path + '/')
        return true if cookie_path.end_with?('/') && request_path.start_with?(cookie_path)
        false
      end

      def fetch_resource(url)
        full_url = resolve_url(url)
        request  = Rack::MockRequest.new(@app)
        response = request.request('GET', full_url, {})
        return nil unless response.status.between?(200, 299)
        response.body
      end

      # JS-facing `fetch` implementation, attached to the V8 context as
      # `__csim_fetch`. Routes the request through the configured Rack app
      # using the active cookie jar and follows up to 20 redirects, mirroring
      # how `navigate` runs full-page requests. Headers come back joined into
      # a hash so the JS shim can reconstruct a `Headers` object.
      FETCH_REDIRECT_LIMIT = 20
      def js_fetch(method, url, headers, body)
        method = (method || 'GET').to_s.upcase
        headers = (headers || {}).each_with_object({}) {|(k, v), m| m[k.to_s] = v.to_s }
        full_url = resolve_url(url)
        redirected = false
        FETCH_REDIRECT_LIMIT.times do
          env = fetch_env_for(headers, full_url)
          input = body.to_s
          request = Rack::MockRequest.new(@app)
          response = request.request(method, full_url, env.merge(input: input))
          ingest_set_cookie(response.headers, full_url)
          if (300..399).cover?(response.status) && response.headers['location']
            target = response.headers['location']
            full_url = resolve_url(target)
            unless [307, 308].include?(response.status)
              method = 'GET'
              body = ''
            end
            headers = headers.reject {|k, _| %w[content-type content-length].include?(k.downcase) } if method == 'GET'
            redirected = true
            next
          end
          return {
            'ok'         => response.status.between?(200, 299),
            'status'     => response.status,
            'statusText' => '',
            'headers'    => normalize_response_headers(response.headers),
            'body'       => response.body.to_s,
            'finalUrl'   => full_url,
            'redirected' => redirected
          }
        end
        {'error' => 'too many redirects'}
      rescue StandardError => e
        {'error' => "#{e.class}: #{e.message}"}
      end

      def fetch_env_for(headers, full_url)
        env = {}
        headers.each do |k, v|
          name = k.to_s
          if name.downcase == 'content-type'
            env['CONTENT_TYPE'] = v.to_s
          elsif name.downcase == 'content-length'
            env['CONTENT_LENGTH'] = v.to_s
          else
            env["HTTP_#{name.upcase.tr('-', '_')}"] = v.to_s
          end
        end
        if @current_url
          env['HTTP_REFERER'] ||= @current_url
        end
        cookie_header = build_cookie_header(full_url)
        env['HTTP_COOKIE'] = cookie_header unless cookie_header.empty?
        env
      end

      def normalize_response_headers(headers)
        out = {}
        headers.each do |name, value|
          val = value.is_a?(Array) ? value.join("\n") : value.to_s
          out[name.to_s] = val
        end
        out
      end

      def stringify_keys(hash)
        hash.each_with_object({}) {|(k, v), m| m[k.to_s] = v }
      end

      # Mirror Selenium's send_keys conventions. Top-level Symbols name a
      # special key; an Array names a "modifier+key" combo where every
      # element except the last is a held-down modifier. Modifier symbols
      # at the top level stay held for everything that follows in the
      # same call (Capybara's "hold modifiers" behaviour).
      def encode_keys(keys)
        Array(keys).flat_map {|k| encode_key(k) }
      end

      def encode_key(k)
        case k
        when String   then [k]
        when Symbol   then [encode_special(k)]
        when Array
          modifiers = k[0..-2].map {|m| symbol_to_key_name(m) }
          tail = k.last
          [{'combo' => modifiers, 'tail' => encode_key(tail)}]
        else [k.to_s]
        end
      end

      def encode_special(sym)
        {'special' => symbol_to_key_name(sym)}
      end

      def symbol_to_key_name(sym)
        case sym
        when :enter, :return then 'Enter'
        when :tab            then 'Tab'
        when :backspace      then 'Backspace'
        when :delete         then 'Delete'
        when :escape         then 'Escape'
        when :space          then ' '
        when :left           then 'ArrowLeft'
        when :right          then 'ArrowRight'
        when :up             then 'ArrowUp'
        when :down           then 'ArrowDown'
        when :home           then 'Home'
        when :end            then 'End'
        when :page_up        then 'PageUp'
        when :page_down      then 'PageDown'
        when :shift, :control, :alt, :meta, :command, :ctrl
          {shift: 'Shift', control: 'Control', ctrl: 'Control',
           alt:   'Alt',   meta:    'Meta',    command: 'Meta'}[sym]
        else sym.to_s.capitalize
        end
      end

      def encode_script_args(args)
        Array(args).map {|v| encode_script_arg(v) }
      end
      def encode_script_arg(value)
        case value
        when Capybara::Simulated::Node
          {'__csim_handle' => value.handle_id}
        when Array
          value.map {|v| encode_script_arg(v) }
        when Hash
          value.each_with_object({}) {|(k, v), m| m[k.to_s] = encode_script_arg(v) }
        else
          value
        end
      end
      def decode_script_result(value)
        case value
        when Hash
          if value['__csim_handle']
            Capybara::Simulated::Node.new(@driver_for_results, value['__csim_handle'])
          else
            value.transform_values {|v| decode_script_result(v) }
          end
        when Array
          value.map {|v| decode_script_result(v) }
        else
          value
        end
      end

      def same_path_anchor?(from_url, to_url)
        a = URI.parse(from_url) rescue nil
        b = URI.parse(to_url) rescue nil
        return false unless a && b
        a.scheme == b.scheme && a.host == b.host && a.port == b.port &&
          a.path == b.path && a.query == b.query &&
          b.fragment && !b.fragment.empty?
      end

      def resolve_url(url)
        return @current_url if url.nil? || url.empty?
        if url.start_with?('http://', 'https://')
          url
        else
          base = current_base_url || @current_url || (Capybara.app_host || DEFAULT_HOST)
          URI.join(base, url).to_s
        end
      end

      # Returns the URL implied by a `<base href>` element on the active
      # page, or nil. happy-dom doesn't apply base href when computing
      # `a.href`, so the driver does its own resolution.
      def current_base_url
        href = @ctx.eval(<<~JS) rescue nil
          (() => {
            const b = document && document.querySelector && document.querySelector('base[href]');
            return b ? String(b.getAttribute('href') || '') : null;
          })()
        JS
        return nil if href.nil? || href.empty?
        return href if href.start_with?('http://', 'https://')
        URI.join(@current_url || (Capybara.app_host || DEFAULT_HOST), href).to_s
      end
    end
  end
end
