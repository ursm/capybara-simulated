require 'nokogiri'
require 'rack/mock'
require_relative 'handle_table'

module Capybara
  module Simulated
    module V2
      DEFAULT_HOST = 'http://www.example.com'

      # Phase-1 skeleton: Ruby/Nokogiri owns the DOM, Capybara DSL goes
      # straight against it, no JS engine yet. Visit, link click, and text
      # reads work; that's enough to drive `:request`-style flows under the
      # Capybara DSL. Forms, JS-driven Stimulus / Turbo, and imperative DOM
      # writes from JS land in subsequent phases.
      class Browser
        attr_reader :app, :current_url

        def initialize(app)
          @app          = app
          @current_url  = nil
          @document     = Nokogiri::HTML5('<!doctype html><html><body></body></html>')
          @handles      = HandleTable.new(@document)
          @cookies      = []
        end

        def visit(url)
          navigate(:get, resolve(url))
        end

        def refresh
          navigate(:get, @current_url) if @current_url
        end

        def reset!
          @document    = Nokogiri::HTML5('<!doctype html><html><body></body></html>')
          @handles.reset!(@document)
          @current_url = nil
          @cookies.clear
        end

        # ── reads ──────────────────────────────────────────────────

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

        # Approximate "visible text" by stripping <head>/<script>/<style>
        # subtrees and collapsing whitespace, matching Capybara's notion.
        def visible_text(handle)
          node = lookup_node(handle)
          return '' if node.nil?
          dup  = node.dup
          dup.css('script, style, head').remove
          dup.text.gsub(/\s+/, ' ').strip
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

        def visible?(handle)
          node = lookup_node(handle)
          return false if node.nil?
          %w[head script style].include?(node.name) ? false : !style_hidden?(node)
        end

        def html
          @document.to_html
        end

        def title
          @document.at('head > title')&.text || ''
        end

        # ── interactions (Phase 1: link click only) ───────────────

        def click(handle)
          node = lookup_node(handle)
          return false if node.nil?
          if node.name == 'a' && (href = node['href'])
            navigate(:get, resolve(href))
            return true
          end
          # TODO: form submit, button click, JS event dispatch in later phases.
          false
        end

        # ── helpers ────────────────────────────────────────────────

        def lookup_node(handle)
          handle && @handles.lookup(handle)
        end

        private

        def navigate(method, url)
          uri  = URI.parse(url)
          path = uri.request_uri
          env  = Rack::MockRequest.env_for(path, method: method.to_s.upcase)
          status, headers, body_iter = @app.call(env)
          body = body_iter.respond_to?(:each) ? +'' : body_iter.to_s
          body_iter.each { |chunk| body << chunk } if body_iter.respond_to?(:each)
          body_iter.close if body_iter.respond_to?(:close)

          if (300..399).cover?(status) && (loc = (headers['location'] || headers['Location']))
            @current_url = resolve(loc, base: url)
            return navigate(:get, @current_url)
          end

          @current_url = url
          @document    = Nokogiri::HTML5(body)
          @handles.reset!(@document)
          status
        end

        def resolve(url, base: @current_url)
          return url if url =~ %r{\A[a-z]+://}i
          URI.join(base || DEFAULT_HOST, url).to_s
        end

        def style_hidden?(node)
          return false unless node.respond_to?(:[])
          style = node['style'].to_s
          return true if style.match?(/display\s*:\s*none/i)
          return true if style.match?(/visibility\s*:\s*hidden/i)
          return true if node['hidden']
          parent = node.respond_to?(:parent) ? node.parent : nil
          parent && parent.respond_to?(:[]) ? style_hidden?(parent) : false
        end
      end
    end
  end
end
