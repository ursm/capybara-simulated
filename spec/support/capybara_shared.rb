# frozen_string_literal: true

require 'timeout'
require 'yaml'
require 'capybara/simulated'
require 'capybara/spec/spec_helper'
require_relative 'js_engine'

# Capybara's upstream shared-spec suite run against our `:simulated` driver.
# The expected-pending set covers tests that need a real layout engine
# (`elementFromPoint`, `getBoundingClientRect` truthiness, viewport-clip
# visibility, …) — see CLAUDE.md for the scoping rule.
#
# SHARDED like the WPT gate (spec/support/wpt_gate.rb): upstream's
# `Capybara::SpecHelper.run_specs` defines the whole ~1400-example suite as ONE
# top-level describe created inside the gem, which pinned the suite to one
# process under the parallel runner — the run's wall-clock floor. Each
# spec/capybara_shared/shard_N_spec.rb holds its own top-level describe and
# calls `CapybaraShared.install(self, shard:, shards:)`, which packs the gem's
# per-file spec registry (`Capybara::SpecHelper.spec` entries) into shards by
# MEASURED group weight (capybara_group_weights.yml, greedy heaviest-first) —
# a blind index stripe landed the three heaviest groups (`node`, `#find`,
# `#click_button`) in one shard, which then dwarfed its siblings. Every shard
# describes itself as plain 'Simulated' so example full-descriptions — and the
# DESCRIPTION_SKIPS prefixes below — stay byte-identical to the former
# monolith.
#
# `install` VENDORS the body of run_specs (capybara 3.40.0,
# lib/capybara/spec/spec_helper.rb) — the describe's includes + its four
# session hooks — because run_specs offers no way to subset the registry or to
# nest its describe under a caller-owned group. On a capybara upgrade, diff
# run_specs against this body.
module CapybaraShared
  # Capabilities our driver doesn't provide, skipped via the gem's own
  # `capybara_skip` metadata filter (the shard files pass this to their
  # top-level describe).
  #
  # `within_frame` routes DOM ops into a per-frame V8 realm, which only the
  # rusty_racer engine builds; under QuickJS frames stay a same-realm fallback,
  # so skip the `frames` capability there (same gate frame_realm_spec uses).
  SKIPPED_TESTS = (%i[
    about_scheme
    server
    windows
  ] + (CsimEngine.v8? ? [] : %i[frames])).freeze

  # Upstream examples we can't satisfy yet, each mapped to the reason RSpec reports as the pending
  # message. Matched as a prefix of the full description.
  STYLE_HASH = 'matcher gap: :style Hash matching'

  DESCRIPTION_SKIPS = ({
    # Click DOES hit-test now, but the interception predicate is deliberately narrower than
    # WebDriver's: only an unrelated obstructor covering the target AND >=80% of the viewport (the
    # modal-backdrop / page-overlay shape) refuses the click, because the coarse layout produces
    # partial sibling overlaps Chrome's geometry doesn't have (measured on Discourse: 131 false
    # interceptions, e.g. a toggle switch's slider over its intentionally tiny checkbox). This
    # upstream fixture's obstructor covers the button but not the page, so no error is raised.
    # The sibling "should retry clicking" / "should allow to retry longer" examples pass.
    'Capybara::Session Simulated node #click should not retry clicking when wait is disabled'    => 'interception is page-covering-overlays only (coarse-layout false positives); this fixture obstructor is element-sized',

    "Capybara::Session Simulated #assert_matches_style should raise error if the elements style doesn't contain the given properties" => STYLE_HASH,
    'Capybara::Session Simulated #has_css? :style option should support Hash'                    => STYLE_HASH
  }.merge(CsimEngine.v8? ? {} : {
    # `#obscured?` in a frame composes geometry across per-frame realms, which only the rusty_racer
    # engine builds (same gate as the `frames` capability above).
    'Capybara::Session Simulated node #obscured? should work in frames'                          => 'needs per-frame realms (V8 only)',
    'Capybara::Session Simulated node #obscured? should work in nested iframes'                  => 'needs per-frame realms (V8 only)'
  })).freeze

  def self.session
    @session ||= Capybara::Session.new(:simulated, TestApp)
  end

  # Measured per-group seconds (script/regen_capybara_group_weights.rb —
  # regenerate on a capybara upgrade; the digest guard flags the moment).
  # Only proportions matter. A group the table doesn't know (added upstream)
  # gets the median so it neither clusters nor skews a bucket. A MISSING
  # table (the regen script's own bootstrap measurement) degrades to equal
  # weights — a valid, merely unbalanced, partition.
  WEIGHTS = begin
    YAML.safe_load_file(File.expand_path('capybara_group_weights.yml', __dir__)).freeze
  rescue Errno::ENOENT
    {}.freeze
  end
  DEFAULT_WEIGHT = WEIGHTS.empty? ? 1.0 : WEIGHTS.values.sort[WEIGHTS.size / 2]

  # Deterministic weighted partition of the registry into `shards` buckets:
  # heaviest-first greedy onto the lightest bucket, index as tie-break.
  # Memoized so every shard file loaded into one process agrees on the same
  # partition (serial runs load all of them).
  def self.partition(shards)
    @partition ||= {}
    @partition[shards] ||= begin
      buckets = Array.new(shards) { {weight: 0.0, indexes: []} }
      # Registry names are mostly Strings, a few are Classes — the weight
      # table keys on the rendered string.
      weight = ->(name) { WEIGHTS[name.to_s] || DEFAULT_WEIGHT }
      Capybara::SpecHelper.instance_variable_get(:@specs)
        .each_with_index
        .sort_by {|(name, _, _), i| [-weight.call(name), i] }
        .each do |(name, _, _), i|
          bucket = buckets.min_by {|b| b[:weight] }
          bucket[:weight]  += weight.call(name)
          bucket[:indexes] << i
        end
      buckets.map {|b| b[:indexes].sort }
    end
  end

  def self.install(group, shard:, shards:)
    # Same partition guard as the WPT gate: a copy-pasted shard file with a
    # stale number reds immediately instead of overlapping a sibling's slice
    # (the count example below catches deletions).
    declared = File.basename(group.metadata[:absolute_file_path])[/\d+/].to_i
    raise ArgumentError, "#{group.metadata[:absolute_file_path]} declares shard: #{shard}" if declared != shard

    session = self.session

    group.class_exec do
      include Capybara::SpecHelper
      include Capybara::RSpecMatchers

      if shard == 1
        it 'has exactly one spec file per shard' do
          expect(Dir.glob(File.expand_path('../capybara_shared/shard_*_spec.rb', __dir__)).length).to eq(shards)
        end

        # The install body below VENDORS run_specs' describe internals, and an
        # upstream release could grow that body a new hook SILENTLY (the
        # @specs read would only fail loudly on removal). Pin the source we
        # copied from by digest: any change to the gem's spec_helper.rb — the
        # upgrade moment where the vendored body must be re-diffed — turns
        # this red with instructions instead of drifting.
        it 'vendors run_specs from the capybara spec_helper this digest pins' do
          require 'digest'
          src = Capybara::SpecHelper.method(:run_specs).source_location.first
          expect(Digest::SHA256.file(src).hexdigest[0, 16]).to eq('136183c0c3772184'),
            "#{src} changed — diff its run_specs against CapybaraShared.install, port any " \
            'difference, and update the pinned digest'
        end
      end

      before do
        @session = session
      end

      after do
        session.reset_session!
      end

      before :each, :psc do
        Capybara::SpecHelper.reset_threadsafe(bool: true, session: session)
      end

      after psc: true do
        Capybara::SpecHelper.reset_threadsafe(session: session)
      end

      before :each, :exact_false do
        Capybara.exact = false
      end

      mine = CapybaraShared.partition(shards)[shard - 1]
      Capybara::SpecHelper.instance_variable_get(:@specs).each_with_index do |(spec_name, spec_options, block), i|
        next unless mine.include?(i)
        describe spec_name, *spec_options do
          class_eval(&block)
        end
      end
    end
  end
end

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
    _, reason = CapybaraShared::DESCRIPTION_SKIPS.find {|prefix, _| example.full_description.start_with?(prefix) }
    skip reason if reason
  end

  # Hang backstop, not an assertion. 60 s leaves headroom for what a loaded
  # parallel runner legitimately stacks inside one example — a couple of 10 s
  # poll_until deadlines, QuickJS VM builds competing with sibling worker
  # processes — while still killing a genuine wedge long before CI's timeout.
  config.around(:each) do |example|
    Timeout.timeout(60, Timeout::Error, 'spec exceeded 60s timeout') { example.run }
  end
end
