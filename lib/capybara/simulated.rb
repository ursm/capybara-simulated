require 'capybara'
require 'capybara/simulated/version'
require 'capybara/simulated/errors'
require 'capybara/simulated/browser'
require 'capybara/simulated/driver'
require 'capybara/simulated/node'
require 'capybara/simulated/v2/driver'

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app)
end

Capybara.register_driver :simulated_v2 do |app|
  Capybara::Simulated::V2::Driver.new(app)
end
