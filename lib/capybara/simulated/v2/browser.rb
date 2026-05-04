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

        def checked?(handle)
          !!lookup_node(handle)&.[]('checked')
        end

        def selected?(handle)
          !!lookup_node(handle)&.[]('selected')
        end

        # ── writes ────────────────────────────────────────────────

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
            else
              node['value'] = value.to_s
            end
          when 'textarea'
            node.children.unlink
            node.add_child(Nokogiri::XML::Text.new(value.to_s, @document))
          end
          true
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

        # ── helpers ────────────────────────────────────────────────

        def lookup_node(handle)
          handle && @handles.lookup(handle)
        end

        private

        def navigate(method, url, body: nil, content_type: nil)
          uri  = URI.parse(url)
          path = uri.request_uri
          opts = {method: method.to_s.upcase}
          opts[:input] = body if body
          opts['CONTENT_TYPE'] = content_type if content_type
          env  = Rack::MockRequest.env_for(path, **opts)
          status, headers, body_iter = @app.call(env)
          response_body = +''
          if body_iter.respond_to?(:each)
            body_iter.each { |chunk| response_body << chunk.to_s }
          else
            response_body << body_iter.to_s
          end
          body_iter.close if body_iter.respond_to?(:close)

          if (300..399).cover?(status) && (loc = (headers['location'] || headers['Location']))
            @current_url = resolve(loc, base: url)
            return navigate(:get, @current_url)
          end

          @current_url = url
          @document    = Nokogiri::HTML5(response_body)
          @handles.reset!(@document)
          status
        end

        def resolve(url, base: @current_url)
          return url if url =~ %r{\A[a-z]+://}i
          URI.join(base || DEFAULT_HOST, url).to_s
        end

        def click_form_control(node)
          type = (node['type'] || (node.name == 'button' ? 'submit' : 'text')).downcase
          case type
          when 'submit', 'image'
            form = enclosing_form(node) or return false
            submit(form, node)
          when 'reset'
            (enclosing_form(node) || node).css('input,textarea,select').each do |f|
              # Re-apply the original `value` / `selected` / `checked` attributes
              # — happy-dom maintains a defaultValue snapshot; we approximate by
              # leaving stored attributes alone and clearing in-memory edits if
              # any exist (Phase-1 doesn't expose those yet).
            end
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
          method = (form['method'] || 'get').downcase
          action = resolve(form['action'].to_s.empty? ? @current_url.to_s : form['action'])
          fields = serialize_form(form, submitter)
          if method == 'post'
            body = URI.encode_www_form(fields)
            navigate(:post, action,
                     body: body,
                     content_type: 'application/x-www-form-urlencoded')
          else
            uri = URI.parse(action)
            uri.query = URI.encode_www_form(fields)
            navigate(:get, uri.to_s)
          end
          true
        end

        def serialize_form(form, submitter)
          out = []
          form.css('input, textarea, select, button').each do |field|
            name = field['name']
            next if name.nil? || name.empty?
            next if field['disabled']
            type = (field['type'] || (field.name == 'button' ? 'submit' : nil) || field.name).downcase
            case type
            when 'submit', 'image', 'button', 'reset'
              # Only the clicked submitter contributes its name/value pair.
              next unless field == submitter
              out << [name, field['value'].to_s]
            when 'checkbox', 'radio'
              out << [name, field['value'] || 'on'] if field['checked']
            when 'select'
              field.css('option').each do |opt|
                out << [name, opt['value'] || opt.text] if opt['selected']
              end
            when 'textarea'
              out << [name, field.text]
            when 'file'
              # Phase-1 stub — multipart upload comes later.
            else
              out << [name, field['value'].to_s]
            end
          end
          out
        end

        def enclosing_form(node)
          if (id = node['form']) && (form = @document.at_css(%[form##{id}]))
            return form
          end
          node.ancestors('form').first
        end

        def label_target(label)
          if (target_id = label['for']) && !target_id.empty?
            return @document.at_css("##{target_id}")
          end
          # Implicit label: first descendant input/select/textarea/button.
          label.css('input,select,textarea,button').first
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
