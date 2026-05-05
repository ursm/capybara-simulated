require 'capybara/node/base'
require 'capybara/node/whitespace_normalizer'

module Capybara
  module Simulated
    class Node < Capybara::Driver::Node
      include Capybara::Node::WhitespaceNormalizer

      def initialize(driver, handle)
        super(driver, handle)
        # Pinning the original Nokogiri node here is what lets `==` and
        # stale-checks survive integer-handle reuse after page reloads.
        @initial_node = driver.browser.lookup_node(handle)
      end

      def handle_id = native

      def all_text
        check_stale
        normalize_spacing(browser.all_text(handle_id))
      end

      def visible_text
        check_stale
        normalize_visible_spacing(browser.visible_text(handle_id))
      end

      def value
        check_stale
        browser.value(handle_id)
      end

      def visible?
        check_stale
        browser.visible?(handle_id)
      end

      def tag_name = browser.tag_name(handle_id)

      def [](name)
        check_stale
        browser.attr(handle_id, name.to_s)
      end

      # Capybara::Node::Element forwards click / right_click / double_click
      # as `base.click(keys_array, **opts)` — keys is one positional Array,
      # not a splat. `delay:` reaches us in seconds; we replay it as a
      # real sleep between mousedown and mouseup so JS handlers reading
      # `Date.now()` see the gap (matches Selenium).
      def click(keys = [], delay: 0, **_opts)
        browser.click(handle_id, keys, delay: delay)
      end

      # right_click and double_click fire the matching event but skip the
      # default action for click — there's no synthesized "open native menu"
      # behaviour to dispatch, and tests typically just look at the JS
      # handler the event triggers.
      def right_click(keys = [], delay: 0, **_opts)
        browser.right_click(handle_id, keys, delay: delay)
      end

      def double_click(keys = [], delay: 0, **_opts)
        browser.double_click(handle_id, keys, delay: delay)
      end

      def send_keys(*keys)
        browser.send_keys(handle_id, keys)
        true
      end

      # Capybara's Element#trigger surfaces here with a String/Symbol
      # event name. Bubbling matches what Capybara's selenium driver
      # produces for synthesised events.
      def trigger(event)
        browser.dispatch_event(handle_id, event.to_s)
        true
      end

      # Element#drop — Capybara's HTML5 drag-and-drop entry point.
      # Accepts file paths (Strings / Pathnames) and / or one Hash
      # `{mime_type => value}` for non-file dataTransfer items. Forwards
      # to Browser#drop which fires the drag event sequence with a
      # dataTransfer payload constructed from the args.
      def drop(*args)
        browser.drop(handle_id, args)
        true
      end

      def set(value, **_opts)
        browser.set_value_with_events(handle_id, value)
      end

      def select_option
        browser.select_option(handle_id)
      end

      def unselect_option
        browser.unselect_option(handle_id)
      end

      def submit(*_args)
        browser.submit_form(handle_id)
      end

      def find_xpath(query)
        browser.find_xpath(query, handle_id).map { |id| self.class.new(driver, id) }
      end

      def find_css(query)
        browser.find_css(query, handle_id).map { |id| self.class.new(driver, id) }
      end

      def shadow_root
        h = browser.shadow_root_handle(handle_id)
        h && self.class.new(driver, h)
      end

      def disabled?    = browser.disabled?(handle_id)
      def selected?    = !!self['selected']
      def checked?     = !!self['checked']
      def readonly?    = !!self['readonly']
      def obscured?(*) = !visible?

      def synchronize(*) = yield
      def style(*)       = {}
      def path           = browser.node_path(handle_id)

      def ==(other)
        other.is_a?(Node) && other.initial_node.equal?(@initial_node)
      end

      protected

      attr_reader :initial_node

      private

      def browser = driver.browser
      def check_stale = browser.check_stale(handle_id, @initial_node)
    end
  end
end
