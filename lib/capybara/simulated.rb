# frozen_string_literal: true

require 'capybara'
require 'capybara/simulated/version'
require 'capybara/simulated/driver'

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app, js_engine: ENV['CSIM_JS_ENGINE']&.to_sym)
end
