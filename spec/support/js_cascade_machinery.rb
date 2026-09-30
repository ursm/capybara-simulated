# frozen_string_literal: true

# An example tagged `js_cascade: true` measures the JS cascade's OWN invalidation machinery — how narrowly its rule
# gates mark a write, which memos they keep, what its walk puts back — so it runs without the style engine, whatever
# mode the suite runs in. Under CSIM_STYLO that machinery is retired: the engine's restyles say what a change reaches
# (layout.js `markRestyles`), and the gates answer conservatively without building the JS rule set.
RSpec.configure do |config|
  config.around(:example, :js_cascade) do |example|
    saved = ENV['CSIM_STYLO']
    ENV['CSIM_STYLO'] = nil
    example.run
  ensure
    ENV['CSIM_STYLO'] = saved
  end
end
