require 'uri'

module Capybara
  module Simulated
    # Shapes a URL string into the component hash the JS bridge expects
    # for `globalThis.location` / `new URL(...)` reads. `Runtime` exposes
    # this through its `__csim_parseUrl` host fn.
    module UrlShape
      module_function

      # WHATWG URL §4.4 requires HTTP(S) URLs to carry a non-empty
      # host; a bare `"https:"` parses but real browsers throw
      # TypeError there. RFC 3986's `URI.parse` happily returns a
      # host-less URI, so re-validate after joining and surface the
      # parse-error shape callers expect.
      SPECIAL_SCHEMES = %w[http https ws wss ftp file].freeze
      private_constant :SPECIAL_SCHEMES

      def parse_for_js(input, base)
        u = base ? URI.join(base, input) : URI.parse(input)
        host = u.host || ''
        if SPECIAL_SCHEMES.include?(u.scheme) && u.scheme != 'file' && host.empty?
          return {'error' => true}
        end
        userinfo = u.userinfo.to_s.split(':', 2)
        port = default_port?(u.scheme, u.port) ? nil : u.port
        path = u.path.to_s.empty? ? '/' : u.path
        href = begin
          out = u.dup
          out.port = port if out.respond_to?(:port=)
          out.path = path if out.respond_to?(:path=)
          out.to_s
        end
        {
          'href'     => href,
          'protocol' => "#{u.scheme}:",
          'username' => userinfo[0] || '',
          'password' => userinfo[1] || '',
          'host'     => port ? "#{host}:#{port}" : host,
          'hostname' => host,
          'port'     => port ? port.to_s : '',
          'pathname' => path,
          'search'   => u.query ? "?#{u.query}" : '',
          'hash'     => u.fragment ? "##{u.fragment}" : '',
          'origin'   => u.scheme && host && !host.empty? ? "#{u.scheme}://#{host}#{port ? ":#{port}" : ''}" : 'null'
        }
      rescue StandardError
        {'error' => true}
      end

      def default_port?(scheme, port)
        (scheme == 'http' && port == 80) || (scheme == 'https' && port == 443)
      end
    end
  end
end
