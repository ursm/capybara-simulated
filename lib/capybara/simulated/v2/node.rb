require 'capybara/node/base'
require 'capybara/node/whitespace_normalizer'

module Capybara
  module Simulated
    module V2
      class Node < Capybara::Driver::Node
        include Capybara::Node::WhitespaceNormalizer

        def initialize(driver, handle)
          super(driver, handle)
        end

        def handle_id = native

        def all_text     = normalize_spacing(browser.all_text(handle_id))
        def visible_text = normalize_visible_spacing(browser.visible_text(handle_id))
        def value        = browser.value(handle_id)
        def visible?     = browser.visible?(handle_id)
        def tag_name     = browser.tag_name(handle_id)
        def [](name)     = browser.attr(handle_id, name.to_s)

        def click(*_args, **_opts)
          browser.click(handle_id)
        end

        # right_click and double_click fire the matching event but skip the
        # default action for click — there's no synthesized "open native menu"
        # behaviour to dispatch, and tests typically just look at the JS
        # handler the event triggers.
        def right_click(*_args, **_opts)
          browser.dispatch_event(handle_id, 'contextmenu')
          true
        end

        def double_click(*_args, **_opts)
          browser.dispatch_event(handle_id, 'click')
          browser.dispatch_event(handle_id, 'click')
          browser.dispatch_event(handle_id, 'dblclick')
          true
        end

        def send_keys(*keys)
          browser.send_keys(handle_id, keys)
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

        def disabled?    = browser.disabled?(handle_id)
        def selected?    = !!self['selected']
        def checked?     = !!self['checked']
        def readonly?    = !!self['readonly']
        def obscured?(*) = !visible?

        def synchronize(*) = yield
        def style(*)       = {}
        def path           = browser.find_xpath('.', handle_id).first.to_s

        def ==(other)
          other.is_a?(Node) && other.handle_id == handle_id
        end

        private

        def browser
          driver.browser
        end
      end
    end
  end
end
