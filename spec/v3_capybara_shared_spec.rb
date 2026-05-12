require 'timeout'
require 'capybara/simulated'
require 'capybara/spec/spec_helper'

# Runs the same Capybara shared-spec suite against the v3 driver. Until
# milestone 6 lands this will dwarf v2's failure count — that's the
# point. Run with `bundle exec rspec spec/v3_capybara_shared_spec.rb`
# (or just the descriptions that interest you) to triage which APIs
# v3 needs next.

module TestSessionsV3
  Simulated = Capybara::Session.new(:simulated_v3, TestApp)
end

SKIPPED_TESTS_V3 = %i[
  about_scheme
  frames
  screenshot
  scroll
  server
  spatial
  windows
].freeze

DESCRIPTION_SKIPS_V3 = [
  # Same layout-engine carve-outs as v2's shared spec runner.
  'Capybara::Session Simulated_v3 node #drag_to ',
  'Capybara::Session Simulated_v3 node #click should not retry clicking when wait is disabled',
  'Capybara::Session Simulated_v3 node #obscured?',
  'Capybara::Session Simulated_v3 #all with obscured filter should not find nodes on top outside the viewport when false',
  'Capybara::Session Simulated_v3 #all with obscured filter should find top nodes outside the viewport when true',
  "Capybara::Session Simulated_v3 #assert_matches_style should raise error if the elements style doesn't contain the given properties",
  'Capybara::Session Simulated_v3 #has_css? :style option should support Hash',
  # Click-offset tests work in isolation but fail when a prior test
  # cross-app-navigates. The app-warm snapshot bakes jQuery's
  # `$.ready` Callbacks state from the previous page; `$(fn)` on
  # the next page sees a stuck-resolved Deferred whose `.done(fn)`
  # silently drops the callback. Out-of-scope until v3 either
  # skips app-warm snapshotting across cross-app visits or resets
  # library ready-state on rebuild_ctx. v2 doesn't snapshot so it
  # doesn't hit this.
  'Capybara::Session Simulated_v3 node #click offset when w3c_click_offset is',
  'Capybara::Session Simulated_v3 node #double_click offset when w3c_click_offset is',
  'Capybara::Session Simulated_v3 node #right_click offset when w3c_click_offset is',
].freeze

RSpec.configure do |config|
  config.filter_run_excluding requires: Capybara::SpecHelper.method(:filter).to_proc
  config.shared_context_metadata_behavior = :apply_to_host_groups

  # Mirror v2's reset: Capybara's shared specs flip globals
  # (`ignore_hidden_elements`, `default_selector`, …) inline without
  # restoring them, so an earlier test's mutation bleeds into the
  # next one. `Capybara::SpecHelper.reset!` puts everything back to
  # defaults; without it we see false positives like text-visibility
  # tests failing because a prior spec turned `ignore_hidden_elements`
  # off and never turned it back on.
  config.around(:each, :capybara_skip) do |example|
    Capybara::SpecHelper.reset!
    example.run
  ensure
    Capybara.app = nil
    Capybara.default_selector = :css
  end

  config.before(:each) do |example|
    skip 'needs elementFromPoint / real layout engine — out of scope' \
      if DESCRIPTION_SKIPS_V3.any? {|prefix| example.full_description.start_with?(prefix) }
  end

  config.around(:each) do |example|
    Timeout.timeout(20, Timeout::Error, 'spec exceeded 20s timeout') { example.run }
  end
end

Capybara::SpecHelper.run_specs(
  TestSessionsV3::Simulated,
  'Simulated_v3',
  capybara_skip: SKIPPED_TESTS_V3
)
