# frozen_string_literal: true

# Notes, in every layout golden, where Chrome's answer differs from it (spec/support/layout_golden.rb): runs the spec
# files that own goldens with `CSIM_LAYOUT_GOLDEN=chrome`, which compares as usual and then renders each compared page
# in headless Chrome and rewrites the entry's `chrome` key. Run it after recording goldens, and review the diff — a note
# that appears is a divergence a recording just accepted, and one that goes is a fix:
#
#   bundle exec ruby script/golden_vs_chrome.rb [spec/native_layout_block_spec.rb ...]
specs = ARGV.empty? ? Dir['spec/fixtures/layout_golden/*.json'].map {|json| "spec/#{File.basename(json, '.json')}.rb" }.sort : ARGV
exec({'CSIM_LAYOUT_GOLDEN' => 'chrome'}, 'bundle', 'exec', 'rspec', *specs)
