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

        def find_xpath(query, **_)
          browser.find_xpath(query).map { |id| Node.new(self, id) }
        end

        def evaluate_script(script, *_args) = browser.evaluate_script(script)
        def execute_script(script, *_args)  = browser.evaluate_script(script)

        def find_css(query, **_)
          browser.find_css(query).map { |id| Node.new(self, id) }
        end

        def invalid_element_errors
          []
        end

        def no_such_window_error
          Capybara::WindowError
        end
      end
    end
  end
end
