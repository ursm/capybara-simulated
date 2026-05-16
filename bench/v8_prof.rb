# frozen_string_literal: true

# Aggregator for V8 `--prof` log files produced by `CSIM_V8_PROF=1`.
# Per-visit `rebuild_ctx` creates one V8 isolate per Context, so a
# real workload (a full spec file, Avo suite, etc.) produces dozens
# of `isolate-*-v8.log` files. Each is processed with
# `node --prof-process` and the per-function tick counts are summed
# so the combined "Bottom up" picture matches one long-running profile.
#
# Recipe:
#
#     CSIM_V8_PROF=1 CSIM_DRIVER=simulated \
#       bin/run-avo spec/system/avo/has_field_discovery_spec.rb
#     ruby bench/v8_prof.rb apps/avo/isolate-*-v8.log
#
# Prints a flat list of the hottest JS / C++ frames across every
# isolate, plus a few of the deepest call stacks. The raw per-isolate
# output of `node --prof-process` is also available individually if
# the aggregate isn't enough.
#
# Note on overhead: V8's `--prof` writes one line per ticking event
# straight to disk, and that I/O typically dominates the libc share
# of the resulting profile. Treat the JS attribution as the load-
# bearing signal; the C++ side of the profile is mostly the
# tracing's own write path.

require 'open3'
require 'json'

logs = ARGV.flat_map { |g| Dir.glob(g) }
abort "usage: #{$PROGRAM_NAME} <isolate-*-v8.log ...>" if logs.empty?

ticks_js   = Hash.new(0)
ticks_cpp  = Hash.new(0)
total      = 0

logs.each do |log|
  out, _, status = Open3.capture3('node', '--prof-process', log)
  unless status.success?
    warn "skip #{log}: node prof-process exited #{status.exitstatus}"
    next
  end
  section = nil
  out.each_line do |line|
    case line
    when /^\s*\[JavaScript\]:/  then section = :js
    when /^\s*\[C\+\+\]:/       then section = :cpp
    when /^\s*\[Summary\]:/     then section = nil
    when /^\s*(\d+)\s+\d+\.\d+%\s+\d+\.\d+%\s+(.+)$/
      next unless section
      ticks, name = $1.to_i, $2.strip
      total += ticks
      (section == :js ? ticks_js : ticks_cpp)[name] += ticks
    end
  end
end

abort 'no ticks recorded — was CSIM_V8_PROF=1 set?' if total.zero?

print_section = ->(label, data) {
  puts "\n[#{label}]  (total ticks: #{data.values.sum})"
  data.sort_by { |_, t| -t }.first(25).each do |name, ticks|
    pct = (ticks * 100.0 / total).round(2)
    printf "  %6d  %5.2f%%  %s\n", ticks, pct, name
  end
}

print_section.('JavaScript', ticks_js)
print_section.('C++',        ticks_cpp)
puts "\nlogs: #{logs.length}  combined ticks: #{total}"
