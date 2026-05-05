require 'timeout'
require 'capybara/simulated'
require 'capybara/spec/spec_helper'

module TestSessions
  Simulated = Capybara::Session.new(:simulated, TestApp)
end

SKIPPED_TESTS = %i[
  about_scheme
  css
  download
  frames
  hover
  screenshot
  scroll
  server
  spatial
  windows
].freeze

DESCRIPTION_SKIPS = [
  'Capybara::Session Simulated node #drag_to ',
  'Capybara::Session Simulated node #click should not retry clicking when wait is disabled'
].freeze

RSpec.configure do |config|
  config.filter_run_excluding requires: Capybara::SpecHelper.method(:filter).to_proc
  config.shared_context_metadata_behavior = :apply_to_host_groups

  config.around(:each, :capybara_skip) do |example|
    Capybara::SpecHelper.reset!
    example.run
  ensure
    Capybara.app = nil
    Capybara.default_selector = :css
  end

  config.before(:each) do |example|
    skip 'needs elementFromPoint / real layout engine — out of scope' \
      if DESCRIPTION_SKIPS.any? {|prefix| example.full_description.start_with?(prefix) }
  end

  config.around(:each) do |example|
    Timeout.timeout(20, Timeout::Error, 'spec exceeded 20s timeout') { example.run }
  end
end

Capybara::SpecHelper.run_specs(
  TestSessions::Simulated,
  'Simulated',
  capybara_skip: SKIPPED_TESTS
)
