# Dev helper: regenerate the WPT conformance allowlists by running the whole
# vendored WPT subset and recording each file's current non-PASS state. Run after
# implementing a fix so the symmetric conformance gate stays honest.
#
#   bundle exec ruby script/regen_wpt_expected_failures.rb
#
# The allowlist is SPLIT across two files:
#   - spec/support/wpt_expected_failures.yml — IN-SCOPE backlog (bare name lists,
#     plus the HARNESS_ERROR sentinel for files whose harness never completes)
#   - spec/support/wpt_out_of_scope.yml      — EARNED non-goals ({name, reason}
#     lists; needs a subsystem we deliberately don't model, per CLAUDE.md rule 1)
#
# Partitioning rule: a freshly-observed failing subtest defaults to IN-SCOPE
# (rule 1: out-of-scope is earned, never assumed). An observed failure that is
# ALREADY listed in wpt_out_of_scope.yml stays out-of-scope and keeps its reason.
# So this script preserves manual out-of-scope classifications across regens; to
# reclassify a subtest, move its line between the two files by hand. A subtest
# that now PASSes is dropped from whichever file listed it.
#
# Output per file (only files with something to record are listed):
#   "dom/nodes/Node-appendChild.html":
#   - "Appending to a text node"        # IN-scope: subtest currently FAIL/TIMEOUT
#   "dom/nodes/some-broken.html": HARNESS_ERROR   # harness never completed
#
# Serialized with Psych (not String#inspect) so the writer's escape grammar is
# the exact inverse of the gate's YAML.safe_load_file reader — a subtest name
# containing e.g. `#{` would make an inspect-quoted scalar that Psych rejects.
#
# The wpt_spec gate is symmetric over the UNION of both files: a non-PASS subtest
# in NEITHER turns the suite RED (fix it or list it), and a listed subtest that
# now PASSes ALSO turns it RED (delete the stale line). Shrinking the in-scope
# file is the parity roadmap.
require 'etc'
require 'tmpdir'
require 'fileutils'
require_relative '../spec/support/wpt_runner'

# A `.tentative` test (or one under a `tentative/` directory) targets an unratified
# spec. Per CLAUDE.md rule 1 these default to OUT-OF-SCOPE — chasing an in-flux spec
# only bakes in churn — and they're self-healing: when WPT ratifies it, the suffix /
# directory goes away, the path changes, and the test re-enters as a fresh in-scope
# failure. So auto-classify their failures out-of-scope instead of hand-listing every
# subtest (one such file carries 100+). A manual out-of-scope entry (the `pool` check
# below) still wins and keeps its specific reason. The rare exception CLAUDE.md notes —
# a `.tentative` behaviour real browsers already ship AND an app depends on, which is
# in-scope — has no carve-out here (this routes it out unconditionally); none qualify
# today, and one that did would need an explicit in-scope allow-set added above.
def tentative_path?(rel)
  rel.match?(%r{(?:\A|/)tentative/}) || rel.match?(/\.tentative\./)
end
TENTATIVE_REASON = 'Unratified `.tentative` spec — auto-classified out-of-scope ' \
  '(chasing in-flux specs bakes in churn). Re-enters in-scope automatically when WPT ' \
  'drops the tentative path/suffix. CLAUDE.md rule 1.'

# WICG / pre-standard files that are morally `.tentative` (an idea-stage proposal no
# browser ships and no app depends on) but DON'T carry a `tentative` path. Listed
# explicitly — NOT auto-routed by "links to WICG", because a WICG-linked feature we DO
# support (e.g. ARIA reflection) must keep failing loudly, not get hidden out-of-scope.
# The reason carries WptRunner::WICG_REASON_TAG (the SAME constant the wpt_spec drift
# check scans for, so the writer and reader can't drift) — that check re-surfaces the
# entry when the test's <link rel=help> stops referencing WICG, i.e. it standardized,
# the signal a missing `.tentative` suffix can't give. Map: rel => reason.
WICG_OUT = {
  'dom/processing-instruction-attributes.html' =>
    "#{WptRunner::WICG_REASON_TAG} declarative-partial-updates (ProcessingInstruction " \
    'attributes) — pre-standard, no browser ships it and no app depends on it; treated ' \
    'like `.tentative`. Has NO `.tentative` filename signal, so the wpt_spec WICG-drift ' \
    'check re-surfaces this when its <link rel=help> stops referencing WICG (it ' \
    'standardized). CLAUDE.md rule 1.'
}.freeze

# Unratified proposals that are morally `.tentative` (an in-flux spec no browser ships and
# no app depends on) but carry NEITHER a `tentative` path NOR a WICG `<link rel=help>` — a
# whatwg proposal still under discussion. Listed explicitly with a reason; routes ALL of the
# file's failing subtests out-of-scope. Unlike WICG_OUT there's no `<link>` drift signal, so
# a re-audit is manual — revisit when the feature lands in the published spec. CLAUDE.md
# rule 1 ("Unratified specs default OUT"). Map: rel => reason.
PROPOSAL_OUT = {
  'fetch/api/body/textstream.any.js' =>
    'Unratified proposal: Request/Response.textStream() is a whatwg/fetch proposal not in ' \
    'the published Fetch Standard — no browser ships it (absent from MDN + the Body IDL) ' \
    'and no app depends on it. No `.tentative` path and no WICG link, so listed explicitly; ' \
    're-audit when it lands in the spec. CLAUDE.md rule 1.'
}.freeze

files = WptRunner.test_files
warn "Running #{files.size} WPT files…"

# Existing out-of-scope classification: rel => queue of [name, reason] per name,
# consumed with multiplicity so a repeated name keeps the right count out-of-scope.
out_existing = WptRunner.out_of_scope.each_with_object({}) do |(rel, entries), h|
  by_name = Hash.new {|hh, k| hh[k] = [] }
  Array(entries).each {|e| by_name[e.is_a?(Hash) ? e['name'] : e] << (e.is_a?(Hash) ? e['reason'] : nil) }
  h[rel] = by_name
end

in_map  = {}   # rel => [name, …]  | HARNESS_ERROR
out_map = {}   # rel => [{ 'name' =>, 'reason' => }, …]
completed_count = 0
error_count = 0
in_subtests = 0
out_subtests = 0

# A file whose result DIFFERS from what is already recorded is run again, and the second run is
# the one recorded. The gate retries a mismatching file (WptGate::FILE_ATTEMPTS) precisely because
# a handful of service-worker files carry an order-dependent timing flake under full-suite load —
# but the regenerator had no such discipline, so a flake here BAKES a false failure into the
# roadmap, and the gate then reds forever on "allowlisted subtest now PASSes". Measured: one
# regen invented `register-same-scope-different-script-url.https.html`, which passes 3/3 alone.
# Costs one extra run per genuinely-changed file, and nothing at all for the corpus that matches.
def confirmed_run(rel)
  result   = WptRunner.run(rel)
  expected = WptRunner.expected[rel]
  same = if result[:completed]
    WptRunner.multiset_minus(result[:failing], Array(expected)).empty? &&
      WptRunner.multiset_minus(Array(expected), result[:failing]).empty?
  else
    expected == WptRunner::HARNESS_ERROR
  end
  same ? result : WptRunner.run(rel)
end

# Run phase, on every core. The corpus is ~10 CPU-minutes and every file is independent (the
# runner resets the session per file, which is what lets the gate shard it at all), so a single
# process was leaving 31 of 32 cores idle: `bin/flatware-rspec spec` covers the same 6000 files in
# ~85 s wall because it uses all of them. Measured on an idle box: 7m26s serial -> 1m23s at eight
# workers, with the same `confirmed_run` flake discipline inside each worker and the classification
# and YAML writing untouched below.
#
# Fork, not threads: a V8 isolate is thread-confined and the isolates have to be independent. The
# parent must not have booted an engine before forking (a forked V8 crashes loudly), which is why
# everything above this line is file and YAML reading only.
#
# A WORK QUEUE rather than a stripe. Index striping is what the gate shards with, and it is good
# enough there, but measured here the slowest stripe ran 21 % over the mean at eight workers (33 %
# at 24) and the tail of the run was mostly idle — per-file cost spans three orders of magnitude.
# Pulling the next index under an flock costs one lock per file against ~70 ms of work, and it
# makes the progress line a real fraction and the crash report name the file.
#
# Eight is a MEMORY choice, not a scaling ceiling: 16 workers finish in 52 s but peak at 15.7 GB
# (measured ~1.25 GB per worker over a ~3.3 GB floor), and contention grows with width — summed
# worker time is +9 % at 8 and +35 % at 16. The default is clamped by available memory too, since
# a box with the cores to want 8 does not necessarily have the RAM.
def worker_count
  raw = ENV['CSIM_REGEN_WORKERS']
  if raw
    parsed = begin
      Integer(raw, 10)
    rescue ArgumentError, TypeError
      abort "CSIM_REGEN_WORKERS must be an integer, got #{raw.inspect}"
    end
    return parsed.clamp(1, 32)
  end
  by_cpu = [Etc.nprocessors - 2, 8].min
  # `MemAvailable` is what the kernel thinks can be handed out without swapping. A worker measured
  # ~1.25 GB peak; leave the floor for the parent and whatever else the machine is doing.
  available_gb = (File.read('/proc/meminfo')[/^MemAvailable:\s+(\d+) kB/, 1].to_i / 1_048_576.0 rescue 0)
  by_mem = available_gb.positive? ? ((available_gb - 2) / 1.25).floor : by_cpu
  [by_cpu, by_mem].min.clamp(1, 32)
end
WORKERS = worker_count

# One shared cursor, taken under an exclusive lock: whichever worker is free next takes the next
# file, so a stripe of cheap files can't finish early while another is still on canvas.
def next_index(path)
  File.open(path, 'r+') do |f|
    f.flock(File::LOCK_EX)
    i = f.read.to_i
    f.rewind
    f.write(i + 1)
    f.flush
    f.truncate(f.pos)
    i
  end
end

def drain_queue(files, cursor, out_path, progress_path)
  results = {}
  loop do
    i = next_index(cursor)
    break if i >= files.size
    rel = files[i]
    # The file this worker is ON, so a crash can name it — `run_stripe` used to write only at the
    # end, so a worker that died at file 700 discarded 700 results and identified none of them.
    File.binwrite(progress_path, rel)
    r = confirmed_run(rel)
    results[rel] = r[:completed] ? {failing: r[:failing]} : {error: r[:error]}
    warn "\r  #{i + 1}/#{files.size}" if ((i + 1) % 50).zero?
  end
  File.binwrite(out_path, Marshal.dump(results))
end

def run_serially(files)
  files.each_with_object({}).with_index do |(rel, h), i|
    r = confirmed_run(rel)
    h[rel] = r[:completed] ? {failing: r[:failing]} : {error: r[:error]}
    warn "\r  #{i + 1}/#{files.size}" if ((i + 1) % 50).zero?
  end
end

def run_in_parallel(files, workers)
  dir      = Dir.mktmpdir('csim-regen')
  cursor   = File.join(dir, 'cursor')
  parts    = (0...workers).map {|w| File.join(dir, "part-#{w}") }
  progress = (0...workers).map {|w| File.join(dir, "at-#{w}") }
  File.binwrite(cursor, '0')
  pids = (0...workers).map {|w|
    fork {
      # A NORMAL exit: the child owns everything its at_exit hooks touch — its own WPT stash (the
      # hook is pid-guarded), its own V8 isolates (the parent never booted one, which is the
      # precondition above), its own script-cache flush. `exit!` skipped all of it and leaked a
      # stash directory and a font tempfile per worker per run, for no speed at all (measured
      # slightly FASTER with a normal exit).
      drain_queue(files, cursor, parts[w], progress[w])
      Process.exit(0)
    }
  }
  begin
    pids.each_with_index do |pid, w|
      _, status = Process.waitpid2(pid)
      next if status.success? && File.exist?(parts[w])
      at = File.exist?(progress[w]) ? File.binread(progress[w]) : '(no file recorded)'
      # The child already printed its own backtrace to this stderr, so don't send anyone to a
      # serial rerun: for a crash you CAN'T see — an OOM kill under memory pressure — serial
      # removes the very condition that caused it, and costs 7 minutes to not reproduce.
      abort "regen worker #{w} died (#{status.inspect}) on #{at}"
    end
    parts.map {|path| Marshal.load(File.binread(path)) }.reduce({}, :merge)
  ensure
    # Whatever happens, no orphans: a worker outliving the parent keeps a ~1.2 GB isolate and a
    # core busy for the rest of its queue, which is the runaway-process shape this project has
    # been bitten by before.
    pids.each {|pid| Process.kill('TERM', pid) rescue nil }
    pids.each {|pid| Process.waitpid(pid) rescue nil }
    FileUtils.remove_entry(dir, true)
  end
end

warn "  #{WORKERS} worker#{'s' unless WORKERS == 1}"
# rel => {failing:} | {error:}. Keyed by path, so the merge order never matters.
results = WORKERS <= 1 ? run_serially(files) : run_in_parallel(files, WORKERS)

files.each do |rel|
  raw    = results.fetch(rel)
  result = raw.key?(:failing) ? {completed: true, failing: raw[:failing]} : {completed: false, error: raw[:error]}
  if result[:completed]
    completed_count += 1
    # Keep the full multiset (no uniq): a subtest name that fails more than once
    # must be recorded with its multiplicity, or the gate's multiset comparison
    # under-counts it and a later same-named regression slips through green.
    pool = out_existing[rel]
    in_list  = []
    out_list = []
    result[:failing].sort.each do |name|
      if pool && pool[name] && !pool[name].empty?
        reason = pool[name].shift
        out_list << { 'name' => name, 'reason' => reason.to_s }
      elsif tentative_path?(rel)
        out_list << { 'name' => name, 'reason' => TENTATIVE_REASON }
      elsif WICG_OUT.key?(rel)
        out_list << { 'name' => name, 'reason' => WICG_OUT[rel] }
      elsif PROPOSAL_OUT.key?(rel)
        out_list << { 'name' => name, 'reason' => PROPOSAL_OUT[rel] }
      else
        in_list << name
      end
    end
    # An unratified file (`.tentative` / WICG / proposal) is out-of-scope WHOLE — a subtest
    # of it that happens to PASS on this machine (a rasterization-sensitive reftest that
    # renders differently on the CI image) must keep its out-of-scope entry, or it re-enters
    # in-scope and reds the gate on the machine where it fails. Re-emit the prior entries the
    # failing-loop above did not consume.
    if in_list.empty? && (tentative_path?(rel) || WICG_OUT.key?(rel) || PROPOSAL_OUT.key?(rel))
      leftover = (out_existing[rel] || {}).flat_map {|name, reasons| reasons.map {|r| { 'name' => name, 'reason' => r.to_s } } }
      leftover.each {|e| out_list << e unless out_list.any? {|o| o['name'] == e['name'] && o['reason'] == e['reason'] } }
      (out_existing[rel] || {}).each_value(&:clear)
    end
    unless in_list.empty?
      in_map[rel] = in_list
      in_subtests += in_list.size
    end
    unless out_list.empty?
      out_map[rel] = out_list
      out_subtests += out_list.size
    end
  else
    error_count += 1
    # A non-completing file is HARNESS_ERROR. Keep it OUT-OF-SCOPE (with its reason)
    # when it's already classified there as a HARNESS_ERROR non-goal — e.g. a
    # target=_blank test that hangs without a real multi-window model — otherwise it
    # defaults in-scope.
    pool = out_existing[rel]
    if pool && pool[WptRunner::HARNESS_ERROR] && !pool[WptRunner::HARNESS_ERROR].empty?
      reason = pool[WptRunner::HARNESS_ERROR].shift
      out_map[rel] = [{ 'name' => WptRunner::HARNESS_ERROR, 'reason' => reason.to_s }]
    else
      in_map[rel] = WptRunner::HARNESS_ERROR
    end
  end
end
warn ''   # close the workers' \r progress line before the summary

in_hdr = <<~H
  # WPT IN-SCOPE backlog — subtests that currently fail but are real driver gaps
  # we intend to fix (the conformance roadmap). Earned out-of-scope failures live
  # in wpt_out_of_scope.yml. The gate (spec/support/wpt_gate.rb) loads BOTH and checks the
  # union symmetrically: a non-PASS subtest in NEITHER file -> RED; a listed subtest
  # that now PASSes -> RED. New failures default here (in-scope) until shown to be
  # an earned non-goal, then moved to wpt_out_of_scope.yml with a reason.
  #
  # Each entry is one file: a list of not-yet-passing subtest names, or the string
  # HARNESS_ERROR if the harness never completed. Shrinking THIS file is the roadmap.
  #
  # Regenerate after a driver fix:  bundle exec ruby script/regen_wpt_expected_failures.rb
  #
H

out_hdr = <<~H
  # WPT OUT-OF-SCOPE failures — subtests that fail because they need a subsystem we
  # deliberately do NOT model (per CLAUDE.md rule 1): a RENDERING engine (glyph shaping
  # — kerning / ligatures / bidi — the line-breaking algorithm, flex / grid track sizing,
  # `display: contents`), a real async runtime, legacy-multibyte / Unicode-version-tied
  # encoding tables, or a spec edge no real library/app depends on. NOT "layout" wholesale:
  # box layout IS modeled (CLAUDE.md lists it as already in scope), so a failing geometry
  # or resolved-value subtest is a coarse-model gap to diagnose, not an automatic exclusion.
  # A REASON GOES STALE when the subsystem it names gets built, and the entry then has to move:
  # 1023 inset / used-value subtests came back on the first such sweep, and 1189 more on the
  # 2026-08-31 audit (innerText's rendered-text collection, elementFromPoint / caret-from-point,
  # pseudo-element computed style, the CSS animation and transition event families, IDNA,
  # render-blocking, and every entry that blamed "no layout engine" for what is really the
  # test_driver input shim discarding coordinates). Re-read the reasons here whenever an engine
  # lands. These are NOT a backlog; each carries the reason it is earned out-of-scope. The
  # in-scope roadmap is wpt_expected_failures.yml.
  #
  # The gate (spec/support/wpt_gate.rb) merges this with the in-scope file and checks the union
  # symmetrically, so an out-of-scope subtest that starts PASSing still turns RED (move
  # it to the in-scope file / delete it). Format per file: a list of {name, reason} —
  # or a single {name: HARNESS_ERROR, reason} entry for a whole file whose harness
  # never completes as an earned non-goal (e.g. a target=_blank test that hangs
  # without a real multi-window model); if such a file later completes, the gate goes
  # RED so it gets reclassified.
  #
  # regen_wpt_expected_failures.rb PRESERVES these classifications + reasons across
  # runs; to reclassify, move a line between this file and wpt_expected_failures.yml.
  #
H

# Key-sorted hashes, emitted by Psych: real YAML escaping so every subtest name
# round-trips through YAML.safe_load_file byte-for-byte.
in_ordered  = in_map.keys.sort.each_with_object({})  {|rel, h| h[rel] = in_map[rel] }
out_ordered = out_map.keys.sort.each_with_object({}) {|rel, h| h[rel] = out_map[rel] }

File.write(WptRunner::EXPECTED_PATH, in_hdr + in_ordered.to_yaml)
File.write(WptRunner::OUT_OF_SCOPE_PATH, out_hdr + out_ordered.to_yaml)

warn "wrote #{WptRunner::EXPECTED_PATH}"
warn "  and  #{WptRunner::OUT_OF_SCOPE_PATH}"
warn "  files:          #{files.size}"
warn "  completed:      #{completed_count}"
warn "  harness errors: #{error_count}"
warn "  in-scope:       #{in_map.size} files / #{in_subtests} subtests"
warn "  out-of-scope:   #{out_map.size} files / #{out_subtests} subtests"
