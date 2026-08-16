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

files.each_with_index do |rel, i|
  result = WptRunner.run(rel)
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
  warn "\r  #{i + 1}/#{files.size}" if ((i + 1) % 25).zero? || i + 1 == files.size
end
warn ''

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
  # deliberately do NOT model (per CLAUDE.md rule 1): a layout/rendering engine, a
  # real async runtime / streams, IDNA / legacy-multibyte encoding tables, or a spec
  # edge no real library/app depends on. These are NOT a backlog; each carries the
  # reason it is earned out-of-scope. The in-scope roadmap is wpt_expected_failures.yml.
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
