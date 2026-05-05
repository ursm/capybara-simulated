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

        def active_element
          handle = browser.active_element_handle
          handle ? Node.new(self, handle) : nil
        end

        # Session-level send_keys: routes :tab / :shift+:tab through the
        # focus order, otherwise targets the active element.
        def send_keys(*keys)
          browser.session_send_keys(keys)
        end

        def accept_modal(type, **options, &block)
          run_modal(type, accept: true, **options, &block)
        end

        def dismiss_modal(type, **options, &block)
          run_modal(type, accept: false, **options, &block)
        end

        private

        def run_modal(type, accept:, text: nil, with: nil, wait: nil, &block)
          captured = nil
          handler = ->(_t, msg, default_value) {
            captured = msg
            modal_response(type, accept, with, default_value)
          }
          browser.with_modal(handler, &block)
          if captured.nil?
            raise Capybara::ModalNotFound, "Unable to find modal dialog with #{text.inspect}"
          end
          if text && !modal_text_matches?(text, captured)
            raise Capybara::ModalNotFound,
              "Unable to find modal dialog with #{text.inspect} (got #{captured.inspect})"
          end
          captured
        end

        def modal_response(type, accept, with, default_value)
          case type
          when :alert   then nil
          when :confirm then accept
          when :prompt
            return nil unless accept
            with.nil? ? default_value.to_s : with.to_s
          end
        end

        def modal_text_matches?(matcher, message)
          matcher.is_a?(Regexp) ? matcher.match?(message) : message.include?(matcher.to_s)
        end

        public

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

        # Capybara's synchronize wrapper catches anything in this list and
        # retries the action after `reload` if automatic_reload is on. We
        # expose the v2 stale-element class so a node detached by a JS
        # `replaceWith` / `removeChild` triggers Capybara's reload path.
        def invalid_element_errors
          [Capybara::Simulated::V2::StaleElement]
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
