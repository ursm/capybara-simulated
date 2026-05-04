require 'capybara/driver/base'
require_relative 'browser'
require_relative 'node'

module Capybara
  module Simulated
    module V2
      class Driver < Capybara::Driver::Base
        attr_reader :app

        def initialize(app)
          @app = app
        end

        def browser
          @browser ||= Browser.new(app)
        end

        def needs_server?       = false
        def javascript_enabled? = true
        def wait?               = false

        def visit(path)      = browser.visit(path)
        def refresh          = browser.refresh
        def reset!           = browser.reset!
        def current_url      = browser.current_url || ''
        def html             = browser.html
        def title            = browser.title
        def status_code      = browser.status_code
        def response_headers = browser.response_headers

        def find_xpath(query, **_)
          browser.find_xpath(query).map { |id| Node.new(self, id) }
        end

        def evaluate_script(script, *args)
          unwrap_script_result(browser.evaluate_script(script, args))
        end

        # Same wire path; Capybara's contract is that execute_script
        # discards the result.
        def execute_script(script, *args)
          browser.evaluate_script(script, args)
          nil
        end

        def evaluate_async_script(script, *args)
          # No async runtime yet — fall back to sync eval so simple cases
          # (scripts that don't actually wait) keep working.
          evaluate_script(script, *args)
        end

        def find_css(query, **_)
          browser.find_css(query).map { |id| Node.new(self, id) }
        end

        def invalid_element_errors
          []
        end

        def no_such_window_error
          Capybara::WindowError
        end

        private

        def unwrap_script_result(value)
          case value
          when Hash
            if (h = value['__elementHandle'])
              Node.new(self, h)
            else
              value.transform_values { |v| unwrap_script_result(v) }
            end
          when Array
            value.map { |v| unwrap_script_result(v) }
          else
            value
          end
        end
      end
    end
  end
end
