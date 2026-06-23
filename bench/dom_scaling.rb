# frozen_string_literal: true

# Large-DOM scaling canary.
#
# The app-suite benches (bench/scenarios.rb) exercise realistic pages but don't
# stress big FLAT DOMs, so a super-linear (O(n²)) regression in a hot DOM path —
# HTML parse, selector match, sibling / ancestor traversal, live collections —
# slips through them (it only bites at scale, e.g. an Avo table or a long
# Discourse topic list). This canary measures each hot path at geometrically
# growing sizes and asserts the cost scales ~LINEARLY: doubling the node count
# should ~double the time, not quadruple it.
#
# Why ratios, not absolute times: the per-doubling ratio cancels the constant
# factors (machine speed, JIT tier, fixed per-visit realm-reset cost), so it's
# stable across machines and runs. Linear work ⇒ ratio ≈ 2 per doubling; O(n²)
# ⇒ ratio ≈ 4. The threshold sits between them (generous, to tolerate linear +
# noise + log factors while still catching a genuine quadratic blow-up). This is
# the guard for CLAUDE.md rule 3 ("per-result O(N) scans on Avo-scale pages") in
# the scaling dimension — the dimension the small app benches are blind to.
#
# It exits non-zero if any path scales super-linearly, so it can gate a branch;
# run it deliberately (not in the default rspec run) since it's timing-based.
#
# Usage:
#   ruby bench/dom_scaling.rb                 # table + PASS/FAIL
#   BENCH_REPS=7 ruby bench/dom_scaling.rb    # more reps → steadier medians

require 'capybara/simulated'
require 'rack'

# Node counts to sweep. Each size N builds ~4·N nodes (see `page`). Geometric
# ×2 steps so consecutive ratios read directly as "cost per doubling".
SIZES = [1000, 2000, 4000].freeze
REPS  = Integer(ENV['BENCH_REPS'] || '5')

# Max tolerated per-doubling ratio. Linear ≈ 2.0, quadratic ≈ 4.0; 3.0 flags a
# real n² while leaving headroom for noise + any n·log n factor.
MAX_RATIO = 3.0

# A representative big page: N rows under ONE container (stresses sibling /
# childNodes traversal + live collections at width), each row nesting a few
# elements (ancestor walks), plus a modest stylesheet so the cascade runs. IDs
# and classes give the selector engine real work.
def page(n)
  rows = (1..n).map {|i|
    "<div class='row r#{i % 8}' id='row-#{i}'>" \
      "<span class='cell'><b>#{i}</b></span>" \
      "<a class='link' href='#x#{i}'>L#{i}</a>" \
    '</div>'
  }.join
  <<~HTML
    <!doctype html><html><head><style>
      .row { display: block }
      .row.r3 { visibility: hidden }
      .cell b { font-weight: bold }
      .link:hover { color: red }
    </style></head><body><main id='container'>#{rows}</main></body></html>
  HTML
end

def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

# Median of `REPS` timings of `block`, in milliseconds. A couple of warm-up
# runs first so we measure the steady (JIT-warm) cost, not tier-up transients.
def measure_ms
  2.times { yield }
  reps = (1..REPS).map { t = now; yield; (now - t) * 1000.0 }
  reps.sort[reps.size / 2]
end

# The hot paths to guard, each as a JS snippet run in-page (already loaded, so
# the per-visit realm-reset cost is excluded and we isolate the op's scaling).
# `K` repeats keep each measurement above timer granularity.
PROBES = {
  'querySelectorAll(.link)'  => "for (let k=0;k<50;k++) document.querySelectorAll('.link').length;",
  'getElementsByClassName'   => "for (let k=0;k<50;k++) document.getElementsByClassName('row').length;",
  'nextElementSibling chain' => "for (let k=0;k<10;k++){let c=document.getElementById('container').firstElementChild,n=0;while(c){n++;c=c.nextElementSibling;}}",
  'querySelector(deep id)'   => "for (let k=0;k<200;k++) document.querySelector('#row-1 .link');"
}.freeze

Capybara.register_driver(:simulated) {|app| Capybara::Simulated::Driver.new(app) }

# Per size: time a full visit (parse + cascade + register), then each in-page
# probe on the loaded document.
samples = {}   # label => { size => ms }
SIZES.each do |n|
  html = page(n)
  app  = Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }
  session = Capybara::Session.new(:simulated, app)
  session.visit('/')   # warm the isolate before timing

  (samples['visit (parse+cascade)'] ||= {})[n] = measure_ms { session.visit('/') }
  session.visit('/')
  PROBES.each do |label, js|
    (samples[label] ||= {})[n] = measure_ms { session.evaluate_script(js) }
  end
  session.driver.quit if session.driver.respond_to?(:quit)
end

# Report: absolute medians per size + per-doubling ratios, flag super-linear.
puts
header = format('| %-26s | %s | %s |', 'path',
                SIZES.map {|n| format('%9s', "n=#{n}") }.join(' | '),
                'ratios (×2 → want ≈2)')
puts header
puts '|' + '-' * (header.length - 2) + '|'

failures = []
samples.each do |label, by_size|
  cells   = SIZES.map {|n| format('%7.3fms', by_size[n]) }
  ratios  = SIZES.each_cons(2).map {|a, b| by_size[b] / by_size[a] }
  worst   = ratios.max
  flag    = worst > MAX_RATIO ? '  !! SUPER-LINEAR' : ''
  failures << [label, worst] if worst > MAX_RATIO
  printf "| %-26s | %s | %s%s\n", label, cells.join(' | '),
         ratios.map {|r| format('%.2f', r) }.join(' '), flag
end

puts
if failures.empty?
  puts "PASS — every hot path scales ~linearly (all per-doubling ratios ≤ #{MAX_RATIO})."
  exit 0
else
  puts "FAIL — super-linear scaling (ratio > #{MAX_RATIO} per ×2) in:"
  failures.each {|label, r| printf "  - %s (worst ×2 ratio %.2f)\n", label, r }
  puts 'A doubling of DOM size more than tripled the cost — likely an O(n²) path.'
  exit 1
end
