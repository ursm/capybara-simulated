# frozen_string_literal: true

require 'tmpdir'

# `bin/ci-rspec` is the gate CI actually runs: the suite, then ONE retry of the examples that run
# reported as failures. Its own header says the exit status is the thing it must not get wrong, and
# it has got it wrong twice — once by keeping `tee`'s status instead of the runner's, and once by
# retrying a LOCATION where the failure was an EXAMPLE. The second is what this pins: a
# capybara-shared shard defines ~200 examples from a single `it`, so they all report the same
# `shard_3_spec.rb:8` and a location-shaped retry re-ran the whole shard — which the script's own
# count guard then refused, so a flake could never be cleared.
#
# The fixtures are generated rather than committed: a spec file that fails on demand has no business
# sitting in `spec/`, where the suite would run it.
RSpec.describe 'bin/ci-rspec' do
  def root = File.expand_path('..', __dir__)

  # Three examples from one `it` line — a shard in miniature — of which `beta` fails the first time
  # it is asked and passes afterwards, through a marker file the run itself writes.
  def flaky_fixture(marker)
    <<~RUBY_SOURCE
      RSpec.describe 'ci-rspec fixture' do
        %w[alpha beta gamma].each do |name|
          it("handles \#{name}") do
            passes = name != 'beta' || File.exist?(#{marker.inspect})
            File.write(#{marker.inspect}, 'seen') unless passes
            expect(passes).to be(true)
          end
        end
      end
    RUBY_SOURCE
  end

  def run_ci_rspec(source)
    Dir.mktmpdir do |dir|
      path = File.join(root, "spec/tmp_ci_rspec_fixture_#{Process.pid}_spec.rb")
      File.write(path, source.call(File.join(dir, 'marker')))
      out = IO.popen(['bin/ci-rspec', path.delete_prefix("#{root}/")],
                     chdir: root, err: [:child, :out], &:read)
      [$?.exitstatus, out]
    ensure
      File.delete(path) if path && File.exist?(path)
    end
  end

  it 'retries the failing EXAMPLE, not every example sharing its location' do
    status, out = run_ci_rspec(method(:flaky_fixture))

    expect(out).to include('retrying the 1 example(s)')
    # The retry ran that one example — not the three the location covers, which is what made the
    # count guard below unsatisfiable before.
    expect(out).to match(/full_description/)
    expect(out).to match(/^1 example, 0 failures/)
    expect(status).to eq(0)
  end

  it 'leaves a failure that a retry cannot clear standing' do
    status, out = run_ci_rspec(->(_marker) { <<~RUBY_SOURCE })
      RSpec.describe 'ci-rspec fixture' do
        it('is red every time') { expect(false).to be(true) }
      end
    RUBY_SOURCE

    expect(out).to include('retrying the 1 example(s)')
    expect(status).not_to eq(0)
  end
end
