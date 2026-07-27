require 'timeout'
require 'capybara/simulated'
require 'capybara/spec/spec_helper'
require_relative 'support/js_engine'

# Capybara's upstream shared-spec suite run against our `:simulated`
# driver. The expected-pending set covers tests that need a real layout
# engine (`elementFromPoint`, `getBoundingClientRect` truthiness,
# viewport-clip visibility, …) — see CLAUDE.md for the scoping rule.

module TestSessions
  Simulated = Capybara::Session.new(:simulated, TestApp)
end

# `within_frame` routes DOM ops into a per-frame V8 realm, which only the
# rusty_racer engine builds; under QuickJS frames stay a same-realm fallback,
# so skip the `frames` capability there (same gate frame_realm_spec uses).
SKIPPED_TESTS = (%i[
  about_scheme
  screenshot
  scroll
  server
  windows
] + (CsimEngine.v8? ? [] : %i[frames])).freeze

DESCRIPTION_SKIPS = ([
  'Capybara::Session Simulated node #drag_to ',
  'Capybara::Session Simulated node #click should not retry clicking when wait is disabled',
  "Capybara::Session Simulated #assert_matches_style should raise error if the elements style doesn't contain the given properties",
  'Capybara::Session Simulated #has_css? :style option should support Hash'
] + (CsimEngine.v8? ? [] : [
  # `#obscured?` in a frame composes geometry across per-frame realms, which only the rusty_racer
  # engine builds (same gate as the `frames` capability above).
  'Capybara::Session Simulated node #obscured? should work in frames',
  'Capybara::Session Simulated node #obscured? should work in nested iframes'
])).freeze

RSpec.configure do |config|
  config.filter_run_excluding requires: Capybara::SpecHelper.method(:filter).to_proc
  config.shared_context_metadata_behavior = :apply_to_host_groups

  # Capybara's shared specs flip globals (`ignore_hidden_elements`,
  # `default_selector`, …) inline without restoring them, so an earlier
  # test's mutation bleeds into the next one. `Capybara::SpecHelper.reset!`
  # puts everything back to defaults; without it we see false positives
  # like text-visibility tests failing because a prior spec turned
  # `ignore_hidden_elements` off and never turned it back on.
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
