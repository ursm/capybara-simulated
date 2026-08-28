# frozen_string_literal: true

# Which WPT SUBTESTS a change breaks, against a base ref.
#
# Per-FILE counts are not the same question and will tell you a change is clean when it is not: a
# file that gains six passes and loses two has fewer failures than before, and the two are invisible.
# That is exactly what happened on the flex static-position change — the allowlist was 813 lines
# shorter and no file's count had grown, while eight subtests that passed on `main` had started
# failing. Adversarial review found them; this finds them next time.
#
# Run AFTER regenerating the allowlist:
#   bundle exec ruby script/regen_wpt_expected_failures.rb
#   bundle exec ruby script/wpt_subtest_diff.rb [base-ref]
require 'yaml'

ALLOWLIST = 'spec/support/wpt_expected_failures.yml'
base = ARGV[0] || 'main'

now = YAML.load_file(ALLOWLIST)
was = YAML.load(`git show #{base}:#{ALLOWLIST}`)
abort "could not read #{ALLOWLIST} at #{base}" unless was.is_a?(Hash)

gained = {}
fixed  = 0
(now.keys | was.keys).each do |file|
  before = (was[file] || []).to_a
  after  = (now[file] || []).to_a
  broke  = after - before
  gained[file] = broke unless broke.empty?
  fixed += (before - after).size
end

broken = gained.values.sum(&:size)
puts "vs #{base}: #{fixed} subtests fixed, #{broken} newly failing"
gained.each do |file, subtests|
  puts "  #{file}"
  subtests.each { |s| puts "      #{s}" }
end
exit(broken.zero? ? 0 : 1)
