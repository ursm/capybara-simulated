# frozen_string_literal: true

# Diagnostic CLI: run one or more WPT files through the :simulated driver and
# print EVERY subtest's status + message — unlike the gate (spec/support/wpt_gate.rb), which
# only checks the non-PASS subtest names against the allowlist and discards the
# assertion messages. Use it to pin the exact failing assertion before touching
# the driver.
#
#   bundle exec ruby spec/support/wpt_diag.rb <relpath> [<relpath> ...]
#
# Shares the gate's machinery (WptRunner.run drives the same visit + real-cadence
# event-loop drain and now returns full per-subtest detail on `:tests`), so the
# results match the gate exactly — there is no second, drifting drain loop here.

require 'capybara'
require 'capybara/simulated'
require_relative 'wpt_runner'

# testharness numeric statuses: 0 PASS, 1 FAIL, 2 TIMEOUT, 3 NOTRUN, 4 PRECONDITION_FAILED.
STATUS = {0 => 'PASS', 1 => 'FAIL', 2 => 'TIMEOUT', 3 => 'NOTRUN', 4 => 'PRECONDITION_FAILED'}.freeze

ARGV.each do |rel|
  result = WptRunner.run(rel)
  unless result[:completed]
    puts "\e[31m#{rel}  HARNESS DID NOT COMPLETE#{result[:error] ? " (#{result[:error]})" : ''}\e[0m"
    next
  end
  tests   = result[:tests] || []
  passing = tests.count {|t| t['status'].to_i.zero? }
  puts "\n=== #{rel}  (#{passing}/#{tests.size} pass) ==="
  tests.reject {|t| t['status'].to_i.zero? }.each do |t|
    st  = STATUS[t['status'].to_i] || t['status'].inspect
    msg = t['message'].to_s.gsub(/\s+/, ' ').strip
    puts "  [#{st}] #{t['name']}"
    puts "        #{msg}" unless msg.empty?
  end
end
