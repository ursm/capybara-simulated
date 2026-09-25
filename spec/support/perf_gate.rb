# frozen_string_literal: true

require 'yaml'
require 'capybara'
require 'capybara/simulated'

# Performance regression gate — the SPEED counterpart to wpt_gate (which holds
# spec conformance). Speed is the driver's reason to exist (CLAUDE.md rule 3):
# it is in-process precisely to beat a real browser per test, and every WPT
# increment risks eroding that lead. This gate runs one fixed, representative
# workload through the :simulated driver and holds it to a recorded baseline on
# two axes.
#
#   1. DETERMINISTIC OP-COUNTS (hard gate) — layout passes, subtree-reuse hits
#      and refusals, structural-context sweeps, cascade versions, parser
#      generations. These are pure functions of the driver's LOGIC (no wall
#      clock), so they are identical across machines, Ruby versions and JS
#      engines; a run-to-run change means a real algorithmic change — an added
#      pass, a dropped reuse, an O(n²) creep. Held EXACTLY (WPT-gate style): any
#      deviation, UP or DOWN, reds the gate, so an improvement must be locked in
#      by regenerating the baseline. That ratchet walks the counts monotonically
#      down and stops a later change from silently giving a win back.
#
#   2. WALL RATIO (soft warn) — the workload's wall time divided by a fixed
#      pure-V8 arithmetic loop measured on the SAME machine in the SAME run. The
#      loop only ROUGHLY normalizes machine speed (the bench/dom_scaling
#      technique: ratios, not absolute times): it does no host calls, allocation
#      or GC, while the workload crosses the Ruby-V8 boundary, allocates DOM and
#      triggers GC, so contention / JIT tier-up touch the two differently and the
#      ratio drifts somewhat on its own. Good enough for a 25%-tolerance trend
#      signal, not an invariant. The warning also goes to $GITHUB_STEP_SUMMARY (a
#      durable, visible CI surface), since a reporter message from a flatware
#      worker on a passing run is easily lost.
#      A constant-factor slowdown the counts CAN'T see — more work per element,
#      not more elements — raises it. Wall is noisy under a loaded CI runner, so
#      this only WARNS; it never reds the gate. But it surfaces the
#      constant-factor creep that is the driver's real existential risk, which a
#      count-only gate would hide behind a green check.
#
# Regenerate the baseline after an intended change (a perf win to lock in, or a
# conformance fix that legitimately shifts the counts):
#   bundle exec ruby script/regen_perf_baseline.rb
#
# Tagged :perf and run in its OWN serial CI step, never the flatware pool: the
# workload is a multi-second CPU burst that would starve timing-sensitive async
# tests in sibling workers (it flaked the ActionCable subscription test) and that
# contention would wreck its own wall ratio. The V8 job runs it once (isolated);
# both flatware runs exclude it via `--tag '~perf'`. The baseline is captured on
# V8, exactly as the WPT allowlist is. See ci.yml.
module PerfGate
  BASELINE_PATH = File.expand_path('perf_baseline.yml', __dir__)

  # The workloads, each a key in the baseline. `grid_table` is the app-shaped page the gate has always
  # run; `shadow_host` is the SAME page with one shadow host beside the table — see `workload_html`.
  # `layout_walk` is the NATIVE-LAYOUT WALK, which nothing else here measures: `__csimLayoutShadowRun` is
  # reached from no dom_op, so a change that makes the walk quadratic costs a green run nothing. One did —
  # a gate predicate that rescanned a box's siblings per child, asked before the cheap test that would have
  # short-circuited it: 117 ms → 1,882 ms on a page with no percentage in it, past `perf 5/0` and into
  # review. The walk becomes the hot path the day native stops being a shadow, so it is measured now.
  # `flex_shell` is an app shell whose flexed cards hold `height: 100%` content — see `FLEX_SHELL_HTML`.
  WORKLOADS = %w[grid_table shadow_host layout_walk flex_shell].freeze

  # Wall ratio may sit this fraction above baseline before the soft warning
  # fires. Generous on purpose: wall is a trend signal, not a tripwire.
  WALL_WARN_TOL = 0.25

  # Warm-up then measured reps for the wall medians — the steady (JIT-warm)
  # cost, matching bench/dom_scaling's methodology. Kept small: the gate runs in
  # its own serial CI step (never the flatware pool — see ci.yml), so this is a
  # few seconds, and the wall axis is only a soft trend signal anyway.
  WALL_WARMUP = 1
  WALL_REPS   = 3

  # Rows in the workload table. Big enough that a real O(n²) slip shows in the
  # counts / ratio, small enough to keep the gate a second or two.
  ROWS = 400

  # A representative app-shaped page: a wide table (sibling / live-collection
  # width), rows nesting a few elements (ancestor walks), and a stylesheet whose
  # rules are DYNAMIC (`:hover`, a state class, an ancestor toggle) so the
  # cascade + layout run for real and the interaction below exercises reuse.
  #
  # INVARIANT — keep this workload's op-counts geometry-independent. Fonts are
  # resolved per machine (fc-match substitutes silently), so text width differs
  # on CI; the held counters must not depend on it. Don't introduce anything that
  # lets geometry move structure — wrapping text that changes box/line count, a
  # mutation that changes text METRICS where an auto table's columns can see it,
  # or a reuse refusal keyed on a sub-pixel width — or the hard gate will red on
  # CI only, for a reason that is not a perf change, and the ratchet erodes into
  # a reflex to regenerate.
  #
  # It was NOT true when this was written, and nothing noticed for months: see the
  # `.row.selected` rule. Check it the way the breach was found — `capture_counts`
  # under a `FONTCONFIG_FILE` that reassigns the families the driver actually asks
  # fontconfig for, which are `Times New Roman` and `Arial` (browser.rb's
  # `GENERIC_FAMILY_DEFAULTS`), NOT `serif` / `sans-serif`; overriding those two
  # changes nothing and reads as a clean bill of health.
  #
  # …and `shadow_host` is that page with ONE shadow host beside the table, whose tree is a `<p>` and a
  # three-declaration stylesheet. It is not a web-component benchmark: a shadow sheet is in no document
  # index, so every document-wide cascade gate that cannot see it has to answer for the whole page, and
  # a host ANYWHERE used to cost EVERY element on it. The counts below are the LIGHT DOM's — the same
  # table — so the two workloads differ only by what the host costs it. When this was added the same
  # relayout took 51 ms without the host and 280 ms with it; the gates ask those sheets now, and the
  # RATIO between the two workloads below is what holds that (see `shadow-host-gates-fail-open`).
  #
  # The COUNT axis holds what the ratio cannot. The class-write gate stayed keyed on the host count
  # after the others were narrowed, and its cost is a subtree mark, not time: `reuse_hit` read 602
  # here against `grid_table`'s 1200 — half the page's subtree reuse — while the wall ratio put the
  # whole difference at ~3%, inside its own noise. It was invisible until `39267549` made the counter
  # font-independent, and the two now differ by the widget's own two boxes.
  def self.workload_html(workload)
    return FLEX_SHELL_HTML if workload == 'flex_shell'

    rows = (1..ROWS).map {|i|
      %(<tr class="row r#{i % 6}" id="row-#{i}">) +
        %(<td class="cell num">#{i}</td>) +
        %(<td class="cell"><a class="link" href="#x#{i}">item #{i}</a></td>) +
        %(<td class="cell"><span class="badge">#{i % 3}</span></td>) +
        '</tr>'
    }.join
    <<~HTML
      <!doctype html><html><head><style>
        table { border-collapse: collapse }
        .row { height: 24px }
        .row.r3 { background: #eee }
        .cell { padding: 2px 8px; border: 1px solid #ccc }
        .row:hover .cell { background: #def }
        /* PAINT-only, and that is the invariant below rather than a style choice: this class goes on half
           the rows mid-interaction, and a `font-weight: bold` here changed the cells' text METRICS, which
           moved the auto table's column widths, which dirtied every row — so `reuse_hit` read 200 with the
           default face and 600 under a fontconfig defaulting to a monospace one, where bold has the same
           advances. A 3x swing in a HARD-held counter for no perf change. Reuse is 1200 either way now.
           The metric-changing mutation the workload still needs is `#container.compact`'s padding, which is
           font-independent; `table-layout: fixed` would have fixed the counter too and was NOT taken,
           because it would have dropped the auto table algorithm — the expensive one — out of the gate. */
        .row.selected .cell { background: #ffe }
        .badge { display: inline-block; min-width: 16px }
        #container.compact .cell { padding: 0 4px }
        /* A `@keyframes` block the page SHIPS and nothing references — Bootstrap's `spin`, Tailwind's
           `ping`. `referencedAnimationNames` exists to keep it from opening the transform gate for
           every element, and a shadow host used to make it give up on the page: 1.12x on this shape
           for a widget that animates nothing. Without it here the ratio below cannot hold that. It
           declares no box and matches no element, so the op-counts stay geometry-independent. */
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        #{WALK_STYLE if workload == 'layout_walk'}
      </style></head><body>
        #{'<div id="host"></div>' if workload == 'shadow_host'}
        <main id="container"><table id="grid"><tbody>#{rows}</tbody></table></main>
        #{WALK_SECTION if workload == 'layout_walk'}
        #{SHADOW_HOST_SCRIPT if workload == 'shadow_host'}
      </body></html>
    HTML
  end

  # …and what `layout_walk` adds: FLEX CONTAINERS with many children each. The walk's per-element
  # predicates are what this gate is here to hold, and the ones that have gone quadratic are the ones that
  # answer a question about a box by looking at its SIBLINGS — `nlComputeMixedBlock` is the one there is, and
  # `nlSubtreeDeclaresWalkPct` reaches it per element it recurses over. A wide level INSIDE an item is what
  # makes that N²; the table above holds the rest of the walk (rows, cells, text blocks, inline content).
  # Deliberately NO percentage anywhere in it: the regression that prompted this was paid by pages that
  # declare none, which is the case a gate is most likely to stop measuring.
  # The SHAPE is the whole point, and two wrong ones went in first — each of which measured the walk
  # without measuring the thing that had gone quadratic. The per-item predicates recurse over an item's
  # subtree and, for each element they reach, ask a question about that element's SIBLINGS. So the cost is
  # N² in the width of a level INSIDE an item, not in the number of items and not in an item whose only
  # child is text (the walk skips text, and the first version of this section reached nothing at all).
  # One flex item per container, holding one block with many children, is the shape that shows it.
  #
  # …and ONE of the eight has a PERCENTAGE on all of its spans, which is not symmetry and not decoration.
  # The route test short-circuits on the declaration, so on a page that declares none the sibling-rescanning
  # answer is never asked and dropping its MEMO costs nothing at all — the half of the hazard the comment
  # names first would be invisible. It has to be asked MANY times under ONE parent for the memo to be what
  # is measured: 300 declaring siblings read `sibScans` 1 memoised and 300 without it.
  # …and one INLINE holding many atomics, whose every record asks which box around it is not an inline box
  # (`nlInlineContainer`) — which scans that inline's children unless the answer is memoised per walk: 300 atomics
  # read `sibScans` 1 memoised and 300 without it (a 2,000-atomic span took the shadow run from 28 ms to 1.5 s).
  WALK_SECTION = ((1..8).map {|c|
    kids = (1..300).map {|k| %(<span class="fi">i#{k}</span>) }.join
    pct  = c == 1 ? ' pctitem' : ''
    %(<div class="flexrow" id="fx-#{c}"><div class="fitem#{pct}"><div>#{kids}</div></div></div>)
  }.join + %(<div><span>#{(1..300).map {|k| %(<span class="ib">#{k}</span>) }.join}</span></div>)).freeze
  # Scoped to this workload: `grid_table` and `shadow_host` are documented as the same page modulo one shadow
  # host, and dead rules in their `<style>` would quietly make that false.
  WALK_STYLE = <<~CSS.freeze
    .flexrow { display: flex }
    .fitem { flex: 1 }
    .pctitem .fi { height: 50% }
    .fi { padding: 1px }
    .ib { display: inline-block }
  CSS

  # A component of the shape a design system ships: its own `<style>`, its own markup, and nothing
  # the table can see. Written as one `innerHTML` so the tree exists before the first read.
  SHADOW_HOST_SCRIPT = <<~HTML.freeze
    <script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
        '<style>.p { color: #333; padding: 2px; font-weight: 600 }</style><p class="p">widget</p>';
    </script>
  HTML

  # The fixed interaction, run once in the loaded page. Each mutate-then-read
  # pair forces a layout pass; the reads after a localized change are where
  # subtree reuse is (or isn't) granted. All deterministic — no timers, no
  # waiting — so the op-counts it produces are reproducible.
  INTERACTION_JS = <<~JS.freeze
    (() => {
      const rows = document.querySelectorAll('#grid .row');
      let h = 0;
      const readAll = () => { for (const r of rows) h += r.getBoundingClientRect().height; };
      readAll();                                                  // initial geometry
      document.getElementById('container').classList.add('compact'); // ancestor toggle -> cascade + wide relayout
      readAll();
      let i = 0;
      for (const r of rows) { if ((i++ & 1) === 0) r.classList.add('selected'); } // state class on half
      readAll();                                                  // partial relayout; untouched rows reuse
      for (let k = 0; k < 20; k++) document.querySelectorAll('#grid .link').length; // structural queries
      return h;
    })()
  JS

  # `layout_walk`'s interaction: the native-layout WALK itself, which is what this workload exists to
  # measure. Run after one geometry read so the oracle's boxes are there for it to compare against, and
  # repeated on the SAME page — a shadow run restores every stamp it touches, so nothing needs re-parsing
  # between reps and the page's first layout stays out of the wall. Its own return value is the op-count
  # vector — `nodes` / `compared` / the four native-coverage counters / `pushedContributions` are pure
  # functions of what the walk DID, so they ratchet exactly as the layout counters do, and a gate that
  # starts refusing shapes shows up as coverage falling rather than as nothing at all. What they CANNOT see
  # is a gate answering the same thing more slowly, which emits the same records — `sibScans` is there for
  # that, and it is the only key here that a pure slowdown moves.
  WALK_JS = <<~JS.freeze
    (() => {
      document.body.offsetHeight;
      let r = null;
      for (let i = 0; i < 3; i++) r = globalThis.__csimLayoutShadowRun();
      return r;
    })()
  JS

  # An app shell: a fixed-height flex COLUMN of flexed cards, each holding an `h-full` child. A flexed item's size
  # is definite (§9.8), so the child's percentage resolves against it — and a layout in which that percentage read
  # the INDEFINITE basis is no answer to the definite question, so the column measures each card and then lays it
  # out again at the size it imposed. Measured again on the next pass, the auto layout could not be reused out of
  # the definite one, and every card was laid out twice per relayout: `reuse_hit` 1506 → 6 and `reuse_remeasured`
  # 0 → 1500 here, 88 ms → 188 ms, and no wall above moved, because no page above has a percentage height under a
  # flexed item. The header toggles between two DECLARED heights, so no count here reads a font metric.
  FLEX_SHELL_HTML = <<~HTML.freeze
    <!doctype html><html><head><style>
      .shell { display: flex; flex-direction: column; height: 800px }
      .card { flex: 1 }
      .fill { height: 100% }
      #hdr { height: 40px }
      #hdr.tall { height: 60px }
    </style></head><body>
      <div class="shell"><div id="hdr">header</div>#{(1..300).map {|i| %(<div class="card"><div class="fill"><span>card #{i}</span></div></div>) }.join}</div>
    </body></html>
  HTML
  FLEX_SHELL_JS = <<~JS.freeze
    (() => {
      const fills = document.querySelectorAll('.fill');
      let h = 0;
      const readAll = () => { for (const f of fills) h += f.getBoundingClientRect().height; };
      readAll();
      for (let k = 0; k < 5; k++) { document.getElementById('hdr').classList.toggle('tall'); readAll(); }
      return h;
    })()
  JS

  # The interaction a workload's page is measured under (the walk's is `WALK_JS`, run in its own branch).
  def self.interaction_js(workload) = workload == 'flex_shell' ? FLEX_SHELL_JS : INTERACTION_JS

  # A pure-V8 arithmetic loop — no DOM, no driver code. Its wall is the machine's
  # raw JS throughput this run, the denominator that normalizes the workload wall.
  CALIB_JS = 'let s = 0; for (let i = 0; i < 3000000; i++) { s += (i * 7) % 13; } s'

  # The counters the hard gate holds — deliberately only the LAYOUT/REUSE hot-path
  # signals. `__csimParserTreeGen` (essentially a node count) and
  # `__csimCascadeVersion` (bumps on any rule-set change / reset) were left out on
  # purpose: they shift on parse5 bumps, UA-sheet edits and conformance-driven
  # invalidation changes that are NOT perf regressions, so holding them exactly
  # would red the gate on unrelated PRs and train everyone to reflexively regen —
  # eroding the ratchet. These five move only when the driver does more (or less)
  # layout work. Read as one object so a single round-trip captures the vector.
  COUNTS_JS = <<~JS.freeze
    ({
      passes:            globalThis.__csimLayoutPasses(),
      reuse_hit:         globalThis.__csimReuseStats().hit,
      reuse_remeasured:  globalThis.__csimReuseStats().remeasured,
      reuse_escapingAbs: globalThis.__csimReuseStats().escapingAbs,
      ctx_sweeps:        globalThis.__csimCtxSweeps(),
      // …and whether the page has a structural-context gate at all, which decides whether a memoised
      // computed value survives a mutation or every one of them dies at every write. A BIT, not a
      // count, and the only counter here that a page can lose wholesale: a shadow host used to turn it
      // off for the whole document, and `ctx_sweeps` then read 0 — fewer sweeps because there was
      // nothing left to sweep, which is the opposite of an improvement and unreadable on its own.
      ctx_gate_active:   globalThis.__csimCtxGateActive() ? 1 : 0
    })
  JS

  # Run one workload and return { 'counts' => {...int}, 'wall' => {...} }. Used
  # by both the gate (install) and the regen script, so they can never diverge.
  def self.capture(workload)
    { 'counts' => capture_counts(workload), 'wall' => capture_wall(workload) }
  end

  # Counts come from a FRESH session (counters start at 0 on a new VM), so the
  # returned values are the workload's absolute op-counts, not a diff.
  def self.capture_counts(workload)
    with_session(workload) do |session|
      session.visit('/')
      if workload == 'layout_walk'
        # …the WALK's own vector, not the layout counters: what it laid out natively, and what it had to
        # ask the oracle for. `ok` rides along as a bit, because a walk that starts DECLINING the page
        # would otherwise show up as every other counter dropping to zero and read like a win.
        r = session.evaluate_script(WALK_JS)
        # `fetch(k, 0)`, not `fetch(k)`: a DECLINING walk returns `{ok: false, reason: …}` and nothing else,
        # and a KeyError here is raised in the outer `before(:context)` — it takes all three workloads down
        # with a message that never mentions the walk. The `ok` bit is what is supposed to say it, so let it.
        @walk_note = r['ok'] ? nil : "the walk DECLINED the page: #{r['reason']}" # …surfaced in the failure
        return WALK_COUNT_KEYS.to_h {|k| [k, k == 'ok' ? (r['ok'] ? 1 : 0) : r.fetch(k, 0).to_i] }
      end
      session.evaluate_script(interaction_js(workload))
      session.evaluate_script(COUNTS_JS).transform_keys(&:to_s).transform_values(&:to_i)
    end
  end
  # …and `sibScans`, the predicate-work counter, which is the one key here that a slower walk MOVES: the
  # coverage counters are pure functions of what the walk produced, so a gate answering the same thing more
  # slowly leaves every one of them alone. `mismatches` is the odd one out in the other direction — it is a
  # geometry comparison, held at 0 as a correctness tripwire rather than as a perf figure.
  WALK_COUNT_KEYS = %w[
    ok
    nodes
    compared
    mismatches
    sibScans
    nativeAtomics
    nativeFlexRows
    nativeIntrinsicGrids
    nativeOutOfFlow
    pushedContributions
  ].freeze

  def self.capture_wall(workload)
    with_session(workload) do |session|
      session.visit('/')   # warm the realm + JIT before timing
      # The walk restores every stamp it touches, so it can be re-run on the SAME page — where
      # `INTERACTION_JS` mutates the DOM and needs a fresh one per rep. Re-visiting for it anyway put the
      # page parse and the ORACLE's first layout into the wall: 58% of it, which is the same work
      # `grid_table` already holds and which diluted this axis to needing a 60% walk regression before it
      # would speak (review-measured).
      walk     = workload == 'layout_walk'
      elapsed  = median_ms { session.visit('/') unless walk; session.evaluate_script(walk ? WALK_JS : interaction_js(workload)) }
      calib    = median_ms { session.evaluate_script(CALIB_JS) }
      {
        'workload_ms' => elapsed.round(3),
        'calib_ms'    => calib.round(3),
        'ratio'       => (elapsed / calib).round(3)
      }
    end
  end

  # What the last `layout_walk` capture saw, where it is worth a word in a failure (the walk declining).
  def self.walk_note = @walk_note ? " #{@walk_note}." : ''

  def self.baseline
    YAML.safe_load_file(BASELINE_PATH)
  end

  # Wire the gate into an RSpec example group — one describe per workload, each capturing ONCE in
  # before(:context) (so a `--tag ~perf` run pays nothing), then asserting the two axes.
  def self.install(group)
    all = baseline
    group.class_exec do
      # ONE capture for every workload, in the OUTER group — the cross-workload example below needs
      # them measured in the same run on the same machine, which is the whole reason its ratio is worth
      # holding at all.
      before(:context) do
        @all = PerfGate::WORKLOADS.to_h {|w| [w, PerfGate.capture(w)] }
      end
    end
    WORKLOADS.each do |workload|
      base = all.fetch(workload)
      group.describe(workload) do
        before(:context) { @measured = @all.fetch(workload) }

        it 'layout / cascade op-counts match the baseline (hard)' do
          expected = base.fetch('counts')
          actual   = @measured.fetch('counts')
          mismatches = (expected.keys | actual.keys).sort.filter_map {|k|
            next if expected[k] == actual[k]
            "  - #{k}: baseline #{expected[k].inspect} → now #{actual[k].inspect}"
          }
          # …and the walk's vector is a different set of things, so it says so rather than talking about
          # passes and reuse: `sibScans` is predicate work, `mismatches` is a native-vs-oracle geometry
          # divergence (`sample` names the first box), `ok: 1 → 0` is the walk refusing the page outright.
          why = workload == 'layout_walk' ?
            "perf counts changed for the native-layout WALK. `sibScans` is per-element predicate work (a " \
            'sibling rescan asked per child), the coverage counters are what it laid out natively, ' \
            "`mismatches` is a geometry divergence and `ok` is the walk declining the page.#{PerfGate.walk_note}" :
            "perf op-counts changed for #{workload}. This is a REGRESSION (added passes / " \
            'dropped subtree reuse / O(n²) creep) or an IMPROVEMENT to lock in.'
          expect(mismatches).to be_empty,
            "#{why} If the shift is intended, regenerate the baseline:\n" \
            "  bundle exec ruby script/regen_perf_baseline.rb\n\n" +
            mismatches.join("\n")
        end

        it 'wall/calibration ratio within the soft budget (warn only, never reds)' do
          expected = base.fetch('wall').fetch('ratio')
          actual   = @measured.fetch('wall').fetch('ratio')
          ceiling  = expected * (1 + PerfGate::WALL_WARN_TOL)
          if actual > ceiling
            wall = @measured.fetch('wall')
            PerfGate.warn_soft(
              "[perf][WARN] #{workload} wall ratio #{actual} > baseline #{expected} × " \
              "#{(1 + PerfGate::WALL_WARN_TOL).round(2)} = #{ceiling.round(3)} " \
              "(workload #{wall['workload_ms']}ms / calib #{wall['calib_ms']}ms). A constant-factor " \
              'slowdown the op-counts cannot see — NOT blocking. Investigate, or regen if intended.'
            )
          end
          # Soft: the wall axis warns but never fails. The example asserts only that
          # the measurement was taken, so the gate's pass/fail stays deterministic.
          expect(actual).to be > 0
        end
      end
    end

    # …and what neither axis above can see: a change that moves a per-element CONSTANT FACTOR. The held
    # counters are all element / pass counts, so they are structurally blind to it — the shadow-host
    # work that took this page from 5.4x to parity moved none of them — and the wall axis warns only
    # UPWARD, so an improvement is never locked in and an equal giveback later sits inside tolerance.
    #
    # The two workloads are the SAME page modulo one shadow host, measured in the same run: their ratio
    # cancels machine speed and load far better than the arithmetic loop does, and it is exactly the
    # quantity three increments in a row moved. Held TWO-SIDED, and soft like the other wall axis —
    # wall is a trend signal, and a reporter warning that fires on an improvement is how the ratchet
    # asks to be regenerated.
    # …which is why these two walls are always re-recorded TOGETHER, even by a change that touches
    # only one of them: either half on its own is not the instrument, and a `grid_table.workload_ms`
    # that moves in a commit that never touched `grid_table` is the regen doing its job.
    ratio_base = all.fetch('shadow_host').fetch('wall').fetch('workload_ms') /
                 all.fetch('grid_table').fetch('wall').fetch('workload_ms')
    group.describe('shadow_host vs grid_table') do
      it 'the same page with a shadow host costs about what the baseline says (warn only)' do
        actual = @all.fetch('shadow_host').fetch('wall').fetch('workload_ms') /
                 @all.fetch('grid_table').fetch('wall').fetch('workload_ms')
        drift  = (actual - ratio_base).abs / ratio_base
        if drift > PerfGate::WALL_WARN_TOL
          PerfGate.warn_soft(
            "[perf][WARN] shadow_host / grid_table wall ratio #{actual.round(3)} vs baseline " \
            "#{ratio_base.round(3)} (#{(drift * 100).round(1)}% drift, tolerance " \
            "#{(PerfGate::WALL_WARN_TOL * 100).round}%). A per-element constant factor the op-counts " \
            'cannot see moved — a regression if UP, a win to lock in if DOWN. Regenerate the baseline ' \
            'either way once you know which.'
          )
        end
        expect(actual).to be > 0
      end
    end
  end

  # Emit a non-failing warning to durable surfaces. stderr always (inherited by
  # flatware workers); the GitHub Actions job summary when present (survives a
  # green multi-process log, where an RSpec reporter message from a worker does
  # not reliably reach the aggregating parent). Best-effort — a warning must
  # never itself break the run.
  def self.warn_soft(message)
    warn(message)
    summary = ENV['GITHUB_STEP_SUMMARY']
    File.write(summary, message + "\n", mode: 'a') if summary && !summary.empty?
  rescue StandardError
    # a lost warning is acceptable; a raised one is not
  end

  # --- internals ---------------------------------------------------------------

  def self.with_session(workload)
    # `:simulated` is registered on `require 'capybara/simulated'` (lib/capybara/simulated.rb).
    app     = workload_html(workload).then {|html| ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }
    session = Capybara::Session.new(:simulated, app)
    begin
      yield session
    ensure
      # `dispose` (not `quit` — the driver has none) is the eager isolate-drop path
      # the driver header prescribes; without it each capture leaks its V8 isolate
      # (heap + workers) into the process-wide live set until at_exit. Idempotent.
      session.driver.dispose if session.driver.respond_to?(:dispose)
    end
  end

  def self.median_ms
    WALL_WARMUP.times { yield }
    reps = Array.new(WALL_REPS) {
      t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      yield
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t) * 1000.0
    }
    reps.sort[reps.size / 2]
  end
end
