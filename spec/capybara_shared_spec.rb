require 'timeout'
require 'capybara/simulated'
require 'capybara/spec/spec_helper'

module TestSessions
  Simulated = Capybara::Session.new(:simulated, TestApp)
end

# Categories of shared specs we don't support (yet). Each tag matches the
# `requires:` metadata Capybara annotates its specs with — see
# `Capybara::SpecHelper.filter`. Anything in this list is silently skipped.
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

# Specs we can't filter through `capybara_skip` because the only
# `requires:` they declare overlaps with capabilities we *do* support
# (e.g. the HTML5 drag context shares `:html5_drag` with `Element#drop`,
# which works). Match these by description prefix instead.
#
# - `#drag_to`: Dragula / SortableJS / jsTree resolve drop targets via
#   `elementFromPoint`, which needs a stacking-context-aware layout.
# - `should not retry clicking when wait is disabled`: same gap — the
#   obscured-element check goes through `elementFromPoint`.
DESCRIPTION_SKIPS = [
  'Capybara::Session Simulated node #drag_to ',
  'Capybara::Session Simulated node #click should not retry clicking when wait is disabled'
].freeze

# Capybara::SpecHelper.configure registers global before/after hooks that
# call `reset!`, which clobbers `Capybara.default_selector` to `:xpath`,
# rewires `Capybara.app = TestApp`, etc. Applied globally those hooks
# leak into other spec files (dsl_spec resolves selectors as :css), so we
# scope reset! to describe groups carrying the `:capybara_skip` metadata
# that `run_specs` stamps below — and clear the leaked global state in
# the around hook on the way out so downstream files see factory
# defaults.
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

  # Bail out of any individual example that takes longer than this. happy-dom
  # plus user JS can occasionally fall into a runaway loop we cannot
  # interrupt from mini_racer, and we'd rather lose one example than the run.
  config.around(:each) do |example|
    Timeout.timeout(20, Timeout::Error, 'spec exceeded 20s timeout') { example.run }
  end
end

Capybara::SpecHelper.run_specs(
  TestSessions::Simulated,
  'Simulated',
  capybara_skip: SKIPPED_TESTS
)
