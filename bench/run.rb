# frozen_string_literal: true

# Driver matrix runner. Invokes RSpec on bench/scenarios.rb under each
# requested driver and prints a comparison table. Each driver is run in
# its own subprocess so RSpec / Capybara state doesn't bleed across.
#
# rack_test is excluded by default — the suite exercises Stimulus and
# Turbo Stream, which need a JS runtime.
#
# Usage:
#   ruby bench/run.rb               # simulated, selenium
#   ruby bench/run.rb simulated     # one driver only
#   BENCH_RUNS=3 ruby bench/run.rb  # take median wall time over N runs

require 'open3'

DRIVERS = ARGV.empty? ? %w[simulated selenium] : ARGV
RUNS    = Integer(ENV['BENCH_RUNS'] || 1)

def time_one(driver)
  cmd = ['bundle', 'exec', 'rspec', '--no-color', '--format', 'progress', 'bench/scenarios.rb']
  out, _, status = Open3.capture3({'BENCH_DRIVER' => driver}, *cmd)
  unless status.success?
    warn "[#{driver}] rspec exited #{status.exitstatus}:\n#{out}"
    return nil
  end
  m_time     = out.match(/Finished in (\d+(?:\.\d+)?) seconds/)
  m_examples = out.match(/(\d+) examples?, (\d+) failures?/)
  return nil unless m_time && m_examples
  {
    seconds:  m_time[1].to_f,
    examples: Integer(m_examples[1]),
    failures: Integer(m_examples[2])
  }
end

def median(xs)
  s = xs.sort
  s.length.odd? ? s[s.length / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2.0
end

results = {}
DRIVERS.each do |d|
  runs = (1..RUNS).map {|i|
    print "[#{d}] run #{i}/#{RUNS} ... "
    r = time_one(d)
    if r
      printf "%.2fs (%d examples, %d failures)\n", r[:seconds], r[:examples], r[:failures]
    else
      puts 'failed'
    end
    r
  }.compact
  next if runs.empty?
  results[d] = {
    seconds:  median(runs.map { it[:seconds] }),
    examples: runs.first[:examples],
    failures: runs.map { it[:failures] }.max
  }
end

puts
puts '| driver        | wall time (median) | per-test  | examples | failures |'
puts '|---------------|--------------------|-----------|----------|----------|'
baseline = results.values.first&.dig(:seconds)
results.each do |driver, r|
  per_test = r[:seconds] / r[:examples]
  ratio    = baseline ? format('%.2fx', r[:seconds] / baseline) : ''
  printf "| %-13s | %8.2fs %7s | %6.3fs   | %8d | %8d |\n",
         driver, r[:seconds], ratio, per_test, r[:examples], r[:failures]
end
