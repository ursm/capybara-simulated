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

# Upstream examples we can't satisfy yet, each mapped to the reason RSpec reports as the pending
# message. Matched as a prefix of the full description.
#
# ONE_GEOMETRY: a real browser has a single geometry that both the synthetic pointer and the page's
# own math read. Here the layout engine (layout.js) is real-ish but PRIVATE — it backs `obscured?` /
# `rect` / `scroll_to` / `drag_to` — while the page-visible surface (`getBoundingClientRect`,
# `elementFromPoint`, `offsetWidth`) is still the coarse placeholder. So a library that resolves the
# pointer against its own measured box can't be driven: jQuery UI droppable and SortableJS compare
# our `clientY` to their `getBoundingClientRect()`, Dragula looks the pointer up through
# `elementFromPoint`. Unifying the two is the next layout increment.
ONE_GEOMETRY = 'needs ONE shared geometry — the page-visible getBoundingClientRect / ' \
               'elementFromPoint is still a coarse placeholder, so a library that resolves the ' \
               "pointer against its own measured box can't be driven"
STYLE_HASH   = 'matcher gap: :style Hash matching'

DESCRIPTION_SKIPS = ({
  # Click doesn't hit-test: it dispatches on the element whatever covers it, so an obscured click
  # never raises. Now buildable on layout.js `isObscured` — a follow-up increment.
  'Capybara::Session Simulated node #click should not retry clicking when wait is disabled'    => 'click does not hit-test through layout yet',

  "Capybara::Session Simulated #assert_matches_style should raise error if the elements style doesn't contain the given properties" => STYLE_HASH,
  'Capybara::Session Simulated #has_css? :style option should support Hash'                    => STYLE_HASH,

  # `drag_to`'s own event sequence is driver-side and works (the whole HTML5 group is green); what
  # remains is every case whose fixture library does its own pointer geometry.
  'Capybara::Session Simulated node #drag_to should drag and drop an object'                   => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to should drag and drop if scrolling is needed'      => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to should drag a link'                               => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to should simulate a single held down modifier key'  => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to should simulate multiple held down modifier keys' => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to should support key aliases'                       => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to should work with Dragula'                         => ONE_GEOMETRY,
  'Capybara::Session Simulated node #drag_to HTML5 should work with SortableJS'                => ONE_GEOMETRY
}.merge(CsimEngine.v8? ? {} : {
  # `#obscured?` in a frame composes geometry across per-frame realms, which only the rusty_racer
  # engine builds (same gate as the `frames` capability above).
  'Capybara::Session Simulated node #obscured? should work in frames'                          => 'needs per-frame realms (V8 only)',
  'Capybara::Session Simulated node #obscured? should work in nested iframes'                  => 'needs per-frame realms (V8 only)'
})).freeze

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
    _, reason = DESCRIPTION_SKIPS.find {|prefix, _| example.full_description.start_with?(prefix) }
    skip reason if reason
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
