require_relative '../spec/support/wpt_runner'
require 'yaml'
allow = {}
%w[spec/support/wpt_expected_failures.yml spec/support/wpt_out_of_scope.yml].each do |f|
  YAML.safe_load_file(f).each {|k,v| allow[k] = Array(v).size }
end
prefixes = ARGV
files = WptRunner.test_files.select {|r| prefixes.any? {|p| r.start_with?(p) } }
tot_before = 0; tot_after = 0; changed = []
files.each do |rel|
  res = WptRunner.run(rel)
  before = allow[rel] || 0
  after  = res[:completed] ? res[:failing].size : 'HE'
  tot_before += before if before.is_a?(Integer)
  tot_after  += after if after.is_a?(Integer)
  changed << [rel, before, after] if after != before
end
puts "files: #{files.size}"
changed.sort_by {|r,b,a| [a.is_a?(Integer)&&b.is_a?(Integer) ? (a-b) : 0] }.each {|r,b,a| puts sprintf("%4s -> %-4s  %s", b, a.to_s, r.sub('html/canvas/element/manual/','').sub('html/canvas/element/','')) }
puts "TOTAL allowlisted(before)=#{tot_before}  actual(after)=#{tot_after}"
