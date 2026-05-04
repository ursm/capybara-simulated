#!/usr/bin/env ruby
# Reads RSpec output and groups failure messages by leading error class /
# Capybara message so we can see which buckets are largest. Run as:
#   ruby spec/triage.rb /tmp/capybara_shared.log
require 'pathname'

path = ARGV[0] || '/tmp/capybara_shared.log'
text = File.read(path)

# RSpec doc/progress format prints `Failure/Error:` followed by the
# offending line and then the error class + message. Grab those.
errors = text.scan(/Failure\/Error:.*?\n\n\s*([A-Z][\w:]+):\s*([^\n]*)/m)

bins = Hash.new(0)
samples = Hash.new {|h, k| h[k] = [] }
errors.each do |klass, msg|
  key = "#{klass}: #{msg.split(/[\n,]/).first.to_s.strip[0, 80]}"
  bins[key] += 1
  samples[key] << msg.strip[0, 200] if samples[key].size < 1
end

puts "total grouped failures: #{errors.size}"
bins.sort_by {|_, n| -n }.each do |key, count|
  puts "#{count.to_s.rjust(4)}  #{key}"
end
