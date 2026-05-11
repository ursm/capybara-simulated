# frozen_string_literal: true

# v3 PoC Browser. Standalone — does *not* inherit from the v2
# `Browser` because the whole point of v3 is to drop the Nokogiri
# tree and its accumulated machinery. Subset of `Browser`'s surface
# wired up so a `Capybara::Session` can `visit` and `find` against
# the V8-resident DOM. Milestones 3+ grow this incrementally.

require 'rack/mock'
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

      def text(handle)    = @runtime.call('__csimText', handle).to_s
      def tag(handle)     = @runtime.call('__csimTag', handle).to_s
      def attr(handle, name) = @runtime.call('__csimAttr', handle, name.to_s)
      def visible?(handle)= @runtime.call('__csimVisible', handle) ? true : false

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
