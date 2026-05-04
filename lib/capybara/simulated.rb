require 'capybara'
require 'capybara/simulated/version'
require 'capybara/simulated/errors'
require 'capybara/simulated/browser'
require 'capybara/simulated/driver'
require 'capybara/simulated/node'

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app)
end
