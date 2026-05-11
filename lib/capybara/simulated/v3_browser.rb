# frozen_string_literal: true

# v3 PoC Browser. Standalone — does *not* inherit from the v2
# `Browser` because the whole point of v3 is to drop the Nokogiri
# tree and its accumulated machinery. Subset of `Browser`'s surface
# wired up so a `Capybara::Session` can `visit` and `find` against
# the V8-resident DOM. Milestones 3+ grow this incrementally.

require 'nokogiri'
require 'rack/mock'
require 'uri'
require_relative 'errors'
require_relative 'v3_runtime'

module Capybara
  module Simulated
    class V3Browser
      DEFAULT_HOST = 'http://www.example.com'

      attr_reader :app, :runtime
      attr_accessor :timers_active, :intersection_observer_active

      def initialize(app)
        @app                          = app
        @runtime                      = V3Runtime.new(self)
        @current_url                  = nil
        @cookies                      = {}
        @sticky_headers               = {}
        @timers_active                = false
        @intersection_observer_active = false
        @document_handle              = 0
      end

      # ── Capybara DSL surface (just enough for milestone 2) ──────

      def visit(url)
        navigate(resolve_against_current(url))
      end

      def current_url
        @current_url || ''
      end

      def find_css(css, context_handle = nil)
        @runtime.call('__csimQuery', context_handle || @document_handle, css.to_s).to_a
      end

      def find_first_css(css, context_handle = nil)
        h = @runtime.call('__csimQueryOne', context_handle || @document_handle, css.to_s).to_i
        h.zero? ? nil : h
      end

      # XPath reverse-bridge (see V3_DESIGN.md "HTML parsing in v3"):
      # serialise the JS subtree with each Element's handle baked into a
      # `data-csim-handle` attribute, run libxml2's XPath on the parsed
      # HTML, recover JS handle ids from the attribute. One Context#call
      # plus one Nokogiri parse per query — still cheap vs v2's
      # per-element __dom callback storm.
      def find_xpath(xpath, context_handle = nil)
        # When the query is rooted at an element, give Nokogiri a
        # fragment; when it's document-rooted ("/html…") we need a full
        # Document so `/html` resolves. Capybara's matchers emit both.
        html = @runtime.call('__csimSerialize', context_handle || 0).to_s
        return [] if html.empty?
        doc = context_handle ? Nokogiri::HTML5.fragment(html) : Nokogiri::HTML5.parse(html)
        doc.xpath(xpath.to_s).filter_map {|n|
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
      def visible_text(handle) = text(handle)
      def tag_name(handle)     = tag(handle)
      def value(handle)        = @runtime.call('__csimValue', handle)
      def disabled?(handle)    = !!attr(handle, 'disabled')
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
        action = @runtime.call('__csimClickResolve', handle)
        return unless action.is_a?(Hash)
        case action['kind']
        when 'navigate' then navigate(resolve_against_current(action['url'].to_s))
        when 'submit'   then submit_form_handle(action['formHandle'], action['submitter'])
        end
      end

      def set_value_with_events(handle, value)
        @runtime.call('__csimSetValue', handle, value)
      end

      def select_option(handle)
        @runtime.call('__csimSelectOption', handle)
      end

      def unselect_option(handle)
        @runtime.call('__csimUnselectOption', handle)
      end

      # `Node#submit(*)` (Capybara DSL) hits here. Find the enclosing
      # form, serialise, post.
      def submit_form(handle)
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
      def polling?                        ; false ; end
      def active_element_handle           ; nil ; end
      def session_send_keys(_)            ; nil ; end
      def with_modal(_)                   ; yield ; end
      def start_trace(_)                  ; nil ; end
      def trace                           ; nil ; end
      def pending_trace                   ; nil ; end
      def clear_trace!                    ; nil ; end
      def evaluate_script(_, _ = [])      ; nil ; end
      def evaluate_async_script(_, _ = []); nil ; end

      def current_path
        return '' if @current_url.nil? || @current_url.empty?
        URI.parse(@current_url).path
      rescue URI::InvalidURIError
        ''
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

      def navigate_post(url, body, content_type)
        env = Rack::MockRequest.env_for(url, method: 'POST', input: body)
        env['CONTENT_TYPE']   = content_type.empty? ? 'application/x-www-form-urlencoded' : content_type
        env['CONTENT_LENGTH'] = body.bytesize.to_s
        env['HTTP_COOKIE']    = document_cookie unless @cookies.empty?
        @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        status, headers, resp_body = @app.call(env)
        merge_set_cookie(headers)
        if (300..399).include?(status) && headers['location']
          resp_body.close if resp_body.respond_to?(:close)
          return navigate(resolve_against_current(headers['location']))
        end
        @current_url = url
        html         = resp_body.is_a?(Array) ? resp_body.join : resp_body.to_s
        resp_body.close if resp_body.respond_to?(:close)
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
      end

      def reset!
        @cookies.clear
        @sticky_headers.clear
        @current_url     = nil
        @document_handle = 0
        @runtime.reset_page
      end

      # ── Host-fn callbacks invoked by v3_bridge.js ───────────────

      def rack_fetch(method, url, body, headers, _redirect_mode)
        env = Rack::MockRequest.env_for(url, method: method.to_s.upcase, input: body || '')
        (headers || {}).each {|k, v| env["HTTP_#{k.to_s.upcase.tr('-', '_')}"] = v }
        @cookies.each {|k, v| env['HTTP_COOKIE'] = "#{env['HTTP_COOKIE']}#{env['HTTP_COOKIE'] ? '; ' : ''}#{k}=#{v}" }
        status, resp_headers, resp_body = @app.call(env)
        body_str = resp_body.is_a?(Array) ? resp_body.join : resp_body.to_s
        resp_body.close if resp_body.respond_to?(:close)
        {'status' => status, 'headers' => stringify(resp_headers), 'body' => body_str}
      rescue StandardError => e
        warn "[capybara-simulated v3] rack_fetch failed: #{e.class}: #{e.message[0, 200]}"
        nil
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
      def handle_modal(*)      ; nil ; end

      private

      # PoC navigate: fetch via the Rack app, hand the body to V8 for
      # parsing. Only follows 3xx redirects up to a small depth.
      def navigate(url, depth: 0)
        raise 'too many redirects' if depth > 10
        env = Rack::MockRequest.env_for(url, method: 'GET')
        env['HTTP_COOKIE'] = document_cookie unless @cookies.empty?
        @sticky_headers.each {|k, v| env["HTTP_#{k.upcase.tr('-', '_')}"] = v }
        status, headers, body = @app.call(env)
        merge_set_cookie(headers)
        if (300..399).include?(status) && headers['location']
          next_url = resolve_against_current(headers['location'])
          body.close if body.respond_to?(:close)
          return navigate(next_url, depth: depth + 1)
        end
        @current_url = url
        html         = body.is_a?(Array) ? body.join : body.to_s
        body.close if body.respond_to?(:close)
        @document_handle = @runtime.call('__csimLoadDocument', html).to_i
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
