# frozen_string_literal: true

require 'capybara'
require 'capybara/simulated/version'
require 'capybara/simulated/driver'
require 'capybara/simulated/v3_driver'

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app)
end

# v3 is the all-in-V8 PoC (see V3_DESIGN.md). Registered separately so
# specs that need either backend can pick by driver name; one's not
# expected to displace the other until milestone 6 (shared-spec parity).
Capybara.register_driver :simulated_v3 do |app|
  Capybara::Simulated::V3Driver.new(app)
end
