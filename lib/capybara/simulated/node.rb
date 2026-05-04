require 'capybara/driver/node'
require 'capybara/node/whitespace_normalizer'

module Capybara
  module Simulated
    class Node < Capybara::Driver::Node
      include Capybara::Node::WhitespaceNormalizer

      def handle_id = native

      def all_text
        normalize_spacing(browser.all_text(handle_id))
      end

      def visible_text
        normalize_visible_spacing(browser.visible_text(handle_id))
      end

      def [](name)
        case name.to_s
        when 'value'    then value
        when 'checked'  then checked? ? 'true' : nil
        when 'selected' then selected? ? 'true' : nil
        else browser.attr(handle_id, name)
        end
      end

      def value
        browser.value(handle_id)
      end

      def set(value, **_opts)
        return if disabled?
        # readonly is meaningless on checkbox/radio; the HTML spec ignores
        # it for those types, and Capybara's specs explicitly assert that.
        type = (self[:type] || tag_name || '').to_s.downcase
        return if readonly? && type != 'checkbox' && type != 'radio'
        browser.set_value(handle_id, value)
      end

      def select_option
        return if disabled?
        browser.select_option(handle_id)
      end

      def unselect_option
        raise Capybara::UnselectNotAllowed, 'Cannot unselect option from single select box.' unless select_node_multiple?
        browser.unselect_option(handle_id)
      end

      def tag_name
        browser.tag_name(handle_id)
      end

      def visible?
        browser.visible?(handle_id)
      end

      def obscured?
        false
      end

      def checked?
        browser.checked?(handle_id)
      end

      def selected?
        browser.selected?(handle_id)
      end

      def disabled?
        browser.disabled?(handle_id)
      end

      def readonly?
        browser.readonly?(handle_id)
      end

      def multiple?
        browser.multiple?(handle_id)
      end

      def click(keys = [], **opts)
        browser.click(handle_id, click_options(keys, opts))
      end

      def right_click(keys = [], **opts)
        browser.right_click(handle_id, click_options(keys, opts))
      end

      def double_click(keys = [], **opts)
        browser.double_click(handle_id, click_options(keys, opts))
      end

      private

      # x/y from Capybara are *offsets* — from top-left when
      # Capybara.w3c_click_offset is false, from center when true. The
      # runtime reads `simRect` to translate these into absolute
      # clientX/clientY before dispatching the mouse events. Defaults
      # (no x/y) target the element's center.
      def click_options(keys, opts)
        out = modifier_options(keys)
        if opts.key?(:x) || opts.key?(:y)
          out['offsetX']   = opts[:x].to_f if opts.key?(:x)
          out['offsetY']   = opts[:y].to_f if opts.key?(:y)
          out['w3cOffset'] = !!Capybara.w3c_click_offset
        end
        out['delay'] = opts[:delay].to_f if opts.key?(:delay) && opts[:delay].to_f.positive?
        out
      end

      def modifier_options(keys)
        opts = {}
        Array(keys).each do |k|
          case k
          when :shift   then opts['shiftKey'] = true
          when :ctrl, :control then opts['ctrlKey'] = true
          when :alt     then opts['altKey'] = true
          when :meta, :command then opts['metaKey'] = true
          end
        end
        opts
      end

      public

      def hover
        browser.hover(handle_id)
      end

      def trigger(event)
        browser.trigger(handle_id, event)
      end

      def send_keys(*keys)
        browser.send_keys(handle_id, keys)
      end

      def drag_to(other, **_opts)
        browser.trigger(handle_id, 'dragstart')
        browser.trigger(other.handle_id, 'dragenter')
        browser.trigger(other.handle_id, 'dragover')
        browser.trigger(other.handle_id, 'drop')
        browser.trigger(handle_id, 'dragend')
      end

      def drop(*args)
        items = args.flat_map {|arg| drop_items_for(arg) }
        browser.drop(handle_id, items)
      end

      def scroll_by(_x, _y); end
      def scroll_to(_element, _alignment, _position = nil); end

      def submit
        browser.submit(handle_id)
      end

      def find_xpath(xpath)
        browser.find_xpath(xpath, handle_id).map {|id| self.class.new(driver, id) }
      end

      def find_css(css)
        browser.find_css(css, handle_id).map {|id| self.class.new(driver, id) }
      end

      def rect
        browser.rect(handle_id)
      end

      def path
        browser.path(handle_id)
      end

      def shadow_root
        id = browser.shadow_root(handle_id)
        id ? Node.new(driver, id) : nil
      end

      def style(_styles)
        raise NotImplementedError, 'The simulated driver does not process CSS'
      end

      def ==(other)
        other.is_a?(Node) && other.handle_id == handle_id
      end

      def inspect
        %(#<Capybara::Simulated::Node tag="#{tag_name}" id=#{handle_id}>)
      rescue StandardError
        super
      end

      private

      def drop_items_for(arg)
        case arg
        when Hash
          arg.map {|type, data|
            {'kind' => 'string', 'type' => type.to_s, 'data' => data.to_s}
          }
        when String
          [{'kind' => 'file', 'name' => File.basename(arg), 'type' => '', 'contents' => safely_read(arg)}]
        else
          []
        end
      end

      def safely_read(path)
        File.binread(path)
      rescue StandardError
        ''
      end

      def browser = driver.browser

      def select_node_multiple?
        browser.evaluate_script(<<~JS)
          (() => {
            const el = (#{select_lookup_js})
            const sel = el.closest('select');
            return !!(sel && sel.multiple);
          })()
        JS
      end

      def select_lookup_js
        # The JS-side handles map is private; use evaluate via a tiny accessor.
        # Cheaper: ask browser directly through path/tag inspection.
        "document.evaluate(#{path.inspect}, document, null, 9, null).singleNodeValue"
      end
    end
  end
end
