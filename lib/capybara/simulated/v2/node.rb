require 'capybara/node/base'

module Capybara
  module Simulated
    module V2
      class Node < Capybara::Driver::Node
        def initialize(driver, handle)
          super(driver, handle)
        end

        def handle_id = native

        def all_text     = browser.all_text(handle_id)
        def visible_text = browser.visible_text(handle_id)
        def value        = browser.value(handle_id)
        def visible?     = browser.visible?(handle_id)
        def tag_name     = browser.tag_name(handle_id)
        def [](name)     = browser.attr(handle_id, name.to_s)

        def click(*_args, **_opts)
          browser.click(handle_id)
        end

        def find_xpath(query)
          browser.find_xpath(query, handle_id).map { |id| self.class.new(driver, id) }
        end

        def find_css(query)
          browser.find_css(query, handle_id).map { |id| self.class.new(driver, id) }
        end

        def disabled?    = !!self['disabled']
        def selected?    = !!self['selected']
        def checked?     = !!self['checked']
        def readonly?    = !!self['readonly']

        def synchronize(*) = yield
        def style(*)       = {}
        def path           = browser.find_xpath('.', handle_id).first.to_s

        def == (other)
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
