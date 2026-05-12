# frozen_string_literal: true

# v3 Node: Capybara::Driver::Node implementation that talks to V3Browser
# only. Separate from v2 `Node` because the v3 PoC needs to evolve its
# surface without dragging v2's accumulated methods (computed_style,
# trace plumbing, drop, shadow_root, …) along for the ride.
# Matching v2's WhitespaceNormalizer keeps `Capybara::Node::Matchers`
# whitespace handling identical across drivers.

require 'capybara/node/base'
require_relative 'errors'
require_relative 'node' # for Simulated::WhitespaceNormalizer

module Capybara
  module Simulated
    class V3Node < Capybara::Driver::Node
      include WhitespaceNormalizer

      def initialize(driver, handle)
        super(driver, self)
        @handle_id    = handle
        @initial_node = driver.browser.lookup_node(handle)
        @context_gen  = driver.browser.context_gen
      end

      attr_reader :handle_id

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

      def click(_keys = [], **_opts)
        check_stale
        browser.click(handle_id)
      end

      def right_click(_keys = [], **_opts)
        check_stale
        browser.right_click(handle_id)
      end

      def double_click(_keys = [], **_opts)
        check_stale
        browser.double_click(handle_id)
      end

      def hover(**_opts)
        check_stale
        browser.hover(handle_id)
        self
      end

      def scroll_to(*, **)       ; self ; end

      def send_keys(*keys)
        check_stale
        browser.send_keys(handle_id, keys)
        true
      end

      def trigger(event)
        check_stale
        browser.dispatch_event(handle_id, event.to_s)
        true
      end
      def drop(*_)               ; true ; end
      def set(value, **_)
        check_stale
        browser.set_value_with_events(handle_id, value)
      end

      def select_option
        check_stale
        browser.select_option(handle_id)
      end

      def unselect_option
        check_stale
        browser.unselect_option(handle_id)
      end

      def submit(*_)
        check_stale
        browser.submit_form(handle_id)
      end

      def find_xpath(query)
        browser.find_xpath(query, handle_id).map {|id| self.class.new(driver, id) }
      end

      def find_css(query)
        browser.find_css(query, handle_id).map {|id| self.class.new(driver, id) }
      end

      def shadow_root      ; nil ; end
      def disabled?        = browser.disabled?(handle_id)
      def selected?        = browser.option_selected?(handle_id)
      def checked?         = !!self['checked']
      def readonly?        = !!self['readonly']
      def obscured?(*)     = !visible?
      def synchronize(*)   = yield
      def style(names = [])
        check_stale
        browser.computed_style(handle_id, Array(names))
      end
      def path             = ''

      def ==(other)
        other.is_a?(V3Node) && other.handle_id == @handle_id
      end

      private

      def browser     = driver.browser
      def check_stale = browser.check_stale(handle_id, @initial_node, @context_gen)
    end
  end
end
