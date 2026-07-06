require_relative '../spec/support/wpt_runner'
rel = ARGV[0]
res = WptRunner.run(rel)
if res[:completed]
  fails = res[:failing]
  puts "COMPLETED. #{fails.size} failing subtests:"
  fails.each {|f| puts "  FAIL: #{f}" }
else
  puts "HARNESS_ERROR: #{res[:error]}"
end
