# frozen_string_literal: true

require 'capybara/simulated'

# The native cascade accelerator (ext/native_cascade) is REQUIRED — no JS fallback — so if it
# weren't loaded, `require 'capybara/simulated'` above would already have failed. This just confirms
# the extension is callable and round-trips data across the boundary. The build itself is gated in
# CI by the `rake compile` step (a broken build fails there).
RSpec.describe Capybara::Simulated::Native do
  it 'is loaded and round-trips data across the boundary' do
    expect(described_class.bench_sum([1, 2, 3, 4])).to eq(10)
    expect(described_class.bench_sum([])).to eq(0)
  end
end
