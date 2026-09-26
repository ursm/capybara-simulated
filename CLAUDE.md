# capybara-simulated — engineering principles

This driver runs Capybara tests in-process: a V8-resident DOM (lives in
`lib/capybara/simulated/js/bridge.js`) driven through rusty_racer, with Nokogiri reserved
for the Rack response side. The codebase has a few load-bearing rules;
deviations have repeatedly cost us regressions or paint us into a
corner.

## 1. Spec conformance is the bar; real-browser behavior is how we check it

This driver exists to run real app suites in-process, so it has to
behave like a real browser. The **primary, objective correctness bar is
spec conformance**, measured by the vendored web-platform-tests gate
(`spec/wpt_gate/`, defined in `spec/support/wpt_gate.rb` — the same tests
Chromium / Firefox hold themselves to). Fix the spec contract and every
library built on it works for free.

The app suites (Avo / Discourse / Forem / Redmine / Mastodon) are the
**integration check and regression early-warning** — they catch
real-world breakage WPT can't: library interaction, ordering across many
APIs, the actual workflows the driver exists for. But they are **not a
frozen-behavior contract**. Keeping every existing app test green with no
changes is *not* a goal. When spec conformance conflicts with a behavior
an app test happened to rely on, favor the spec: make the driver
spec-correct and update the test. Do **not** grow a driver hack to
preserve a quirk (that's rule 2), and don't spend effort chasing
driver-dependent edge cases just to lift a green count.

This is what lets us make foundational pieces more spec-faithful even
when it shifts app-test timing — e.g. moving the timer / event-loop model
from the pragmatic wall-sync clock toward a real HTML event loop (task
queues + microtask checkpoints + spec timer ordering).

### In scope vs out of scope

Out-of-scope status is **earned by showing why a subtest can't be
satisfied**, never assumed because a fix looks like work. The default is
**in scope**. A subtest is out of scope (allowlisted / skipped, *not* a
driver bug) only when one of these holds:

1. **It needs a subsystem we deliberately don't model.** A *rendering*
   engine — glyph SHAPING (kerning, ligatures, bidi, the line-BREAKING
   algorithm) — a real async
   runtime, or legacy-multibyte / Unicode-version-tied
   encoding tables (ISO-2022-JP & friends; the *residual* IDNA cases where
   `uri-idna` diverges from the WPT reference — **not IDNA wholesale**: see
   the in-scope note below).
2. **It's a spec edge no real browser-built library or app depends on,
   AND satisfying it would require a library-shaped hack (rule 2) or a
   *measured* performance regression (rule 3).** Examples: attribute /
   property names around the 2³² index boundary; `Object.freeze` on a
   platform exotic object.

Everything else is in scope — fix it, favouring spec over app-quirk.
Cost and risk decide **priority and approach (incremental, perf-safe,
validated), not whether.** A high-cost-but-correct change (e.g. the
namespaced-attribute model: SVG `xlink:href`, case-sensitivity — all
real contracts) is scheduled as a careful staged effort, never skipped
for being tedious. "Addressable but annoying" is a backlog item, not an
exclusion. **"Not modeled yet / haven't built it" is never itself a reason
— that's the backlog.** An earned out-of-scope names the *subsystem* and
*why it can't be satisfied here*, not the effort.

**Already in scope — do NOT re-exclude these** (each has been wrongly
earned-out before as "a subsystem we don't model", then reverted):
- **Multi-origin: cross-origin iframes, SOP, postMessage-origin,
  `document.domain`, storage / Blob-URL partitioning.** Buildable in-process
  plumbing on parts we already have (per-frame V8 realms, the Rack harness);
  cross-origin is pure ORIGIN TAGGING, not a network boundary — no real DNS
  / `*.localhost` needed. Backlog, not a non-goal. (See the
  `multi-origin-in-scope` memory.)
- **Box layout is MODELED** (`js/src/layout.js`, since v0.8.0): block flow,
  inline runs, absolute / relative / fixed (shrink-to-fit included), margin
  collapsing, floats, FLEX layout (line breaking + grow/shrink distribution),
  a coarse grid pass, CSS Tables 3 auto/fixed TABLE layout, overflow
  clipping, the flat tree, cross-realm frames — and the page-visible geometry
  (`getBoundingClientRect` / `elementFromPoint` / `offset*` / `client*` /
  `scroll*`) reads from it, so there is ONE geometry. Visual hit-testing,
  gBCR truthiness and viewport-clip visibility are therefore IN scope: a
  failing geometry test is a coarse-model gap to diagnose (does it need glyph
  SHAPING, or just a box rule we haven't written?), not an
  automatic "needs a layout engine" exclusion.
- **FLEX SIZING is IN SCOPE** — the "flex / grid track sizing" clause above was
  written before `layout.js` existed and was retired 2026-08-31. `flexLines`
  breaks lines and `resolveFlexRowWidths` distributes free space over
  `flex-grow` / `flex-shrink` today; the css-flexbox allowlist earns out exactly
  six `.tentative` files and nothing for sizing, and the ~1000 remaining
  subtests are coarse-model gaps (e.g. the scrollable overflow region), not a
  missing algorithm. css-grid is simply not vendored — un-measured, not
  excluded. (See the `flex-sizing-in-scope` memory.)
- **Text is MEASURED, not estimated** (since v0.8.x): run widths come from the
  font file's own `hmtx` advances and line boxes from its `hhea` metrics, for
  the face fontconfig resolves the CSS family to — the same face Chrome gets on
  the same machine. So a wrong text width is a bug to diagnose, not "we don't
  have glyph metrics". What is still missing is SHAPING (kerning / ligatures /
  bidi) and the real line-breaking algorithm.
- **`display: contents` is MODELED** — the clause above listed it as an
  unmodelled *rendering* subsystem beside glyph shaping, and that was retired
  2026-09-20. It generates NO BOX: for layout the element is replaced by its
  children, in its place (CSS Display 3 §3.1), and `layout.js` says that in
  three places and only three. `layoutChildren` enumerates the children the FLOW
  lays out, looking through every box-less one to the children that stand in for
  it, and every box-level consumer in both engines asks it — the oracle's block
  flow, its flex and grid item collection, its margin-collapsing run, its
  clearance scan and its baseline candidates, and the walk's pre-filters and run
  gather. `inlineStyleOwner` carries the one thing a list cannot: a RUN spliced
  through such an element still draws with that element's font, collapses by its
  `white-space` and sits on its `line-height`, and a text node has no element of
  its own to ask. INHERITED properties only, and that is the rule rather than a
  shortcut — what a box-less element can hand its content is exactly what
  inherits to it, so `vertical-align` (not inherited, and applying to an inline
  BOX) is read off the nearest element that HAS one, as Chrome does.
  `generatesBox` gives it no box at all, so it can neither float, establish a
  context, nor answer a geometry read. The raw flat-tree list is
  `flatTreeChildren`, and a caller that wants THAT is the exception: the plain
  name is the looking-through one on purpose, because picking the wrong one by
  default is how the bug below survived as long as it did.
  Thirty-one shapes are held against headless Chrome in
  `spec/display_contents_spec.rb`, every one of them also asserting that the
  native walk took the shape and compared something — inline content on a line,
  one and two block children through it, a flex item, a grid item, ignored
  padding, nested `contents`, a float through it, `max-content` across it, a
  table row through it, a margin collapsing through it, an out-of-flow one that
  IS a box again, a baseline-aligned flex item, a font-size / a wrap / a
  `white-space` / a `line-height` through one, a `vertical-align` on one (which
  is IGNORED) and one on an inline box around one (which is not) with the boxed
  span as the control, a styled `<slot>`'s assigned text, a float written AFTER
  a box spliced through one, an overflowing subtree behind one, and six
  percentage-sized pseudos — with the Chrome figures in the
  file, because an argument that lives only in a commit message is the "memory
  of a measurement" this list exists to replace.
  The gap this entry used to name is CLOSED (2026-09-22). A box-less element
  resolved a USED WIDTH of its own, so a percentage-sized `::before` / `::after`
  of one resolved against that instead of against the parent's content box —
  40px where Chrome says 50 — and likewise through `padding`, through a `margin`
  that is no box's edge at all, and through a declared `width` that replaced the
  basis outright. A phantom box, and it was the OTHER engine's block flow that
  kept it: once one enumeration is what lays the children out, there is no box
  for the percentage to find. `css/cssom/getComputedStyle-pseudo.html` came off
  the allowlist with it, and the native WALK takes the shapes it used to refuse:
  all thirty-one of the spec's, where it declined nine of the first ten, and
  1,512 fewer cases of the 17,280-case `pseudo` sweep (4,800 declines to 3,288 —
  `block-level-box-unplaceable` 2,640 to 1,296, the rest being `display:
  table-row`, which is its own backlog item).
  The cost of getting there is the lesson worth keeping: the phantom box was
  load-bearing for every list that had NOT been converted, and the failures it
  had been hiding were each invisible in a different way. A baseline read
  `child._lb.y` off a box that no longer existed and killed a corpus file
  mid-run, so a crash arrived as an ok-count ten lower. The scrollable-overflow
  walk found no `_lbExt`, skipped the subtree and reported a scroller
  unscrollable — no mismatch, no decline, no crash. The clearance scan's
  identity test stopped matching and reported a float written AFTER a box as one
  it must clear. And the runs spliced out of the element lost its font,
  `white-space` and `line-height` in BOTH engines at once — right before the
  flatten and wrong after it, with parity never broken and so no sweep able to
  see it. Parity is blind to a shared error, and a single enumeration is only
  safe when the plain name is the one that looks through.
  The allowlist still holds nine subtests mentioning `display: contents`: an
  animation inside one, a flex item's computed `min-width`, five form controls'
  computed `display`, a wheel-event target change, and `commitStyles` in a
  `display: none` subtree. None is a layout gap. All nine are re-tested every
  run — the gate turns RED on an allowlisted subtest that starts passing.
- **IDNA, Streams, Workers, EventSource are MODELED** (uri-idna /
  web-streams-polyfill / thread / TCPSocket). A failing IDNA test is usually
  a driver over-/under-rejection bug to fix (e.g. an `xn--` A-label browsers
  keep but we rejected), not a "Unicode table" to exclude — diagnose the
  actual divergence first.

**Unratified specs default OUT** — chasing an in-flux spec only bakes in
churn. A `.tentative` path/suffix is auto-routed out-of-scope by
`regen_wpt_expected_failures.rb` and self-heals (ratification changes the
path → it re-enters in-scope as a fresh failure). An idea-stage **WICG**
proposal with no `.tentative` in its name is listed explicitly with a
`[WICG]`-tagged reason; the `wpt_gate` drift check turns the gate RED when
that test's `<link rel=help>` stops referencing WICG (it standardized), so
it gets re-audited — the signal the missing suffix can't give. Do **not**
blanket-exclude every WICG-linked test: a WICG-linked feature we DO support
(ARIA reflection) must keep failing loudly, never be hidden out-of-scope.

A bounded, documented conformance gap is acceptable **only** when it's
the deliberate cost of a load-bearing design choice and the alternative
costs more than it's worth — e.g. `HTMLCollection extends Array` (for
framework array-iteration compat) forces `length` into
`getOwnPropertyNames`. List and justify these explicitly; don't let them
multiply.

Caveat: real-browser behavior is the tiebreak only where the spec does
not say. Where the spec is silent or ambiguous, match Chromium / Firefox
observable behavior (rule 2) — and where both engines agree on something
the spec leaves open, follow them. Where the spec DOES say and one engine
departs from it, the spec wins: Chrome is not the only browser, and a
Blink quirk is not a contract (e.g. Chrome keeps a `<br>` a line break
whatever `display` / `float` / `position` it declares; the spec, and
Firefox, apply them). Check a second engine before calling a behavior
"what browsers do" — Firefox is at `/usr/bin/firefox-bin` (headless
`--screenshot`; it has no `--dump-dom`). A behavior real browsers *do*
have, that an app depends on, is in scope and must work.

## 2. No library-shaped hacks

It is tempting to add `if node.tagName == 'TRIX-EDITOR' …` or check
for `data-controller="key-value"`. Don't.

The fix has to come from one of two places:

- **Spec compliance.** The DOM, HTML, and Web platform specs describe
  the contracts (`beforeinput` cancel-and-default, `<template>` content
  fragment, `readystatechange` on `document.readyState` transitions,
  `<option value="">` serialization, …). Fix the contract and every
  library that depends on it works for free.
- **Real-browser observable behavior.** Where the spec is silent or
  ambiguous (e.g. `innerText` falling back to `textContent` when an
  element isn't being rendered), match what Chromium / Firefox actually
  do. Verify with a small repro page if necessary.

If the failing test is one library on top of standard surfaces, the
fix lives in those surfaces. Specifically:
- Trix not seeing typed text → fix `set` for contenteditable to fire
  `beforeinput` with `inputType` / `data` / `getTargetRanges` on the
  prototype, not "detect Trix".
- Tagify not rendering tags → fix DOMParser cross-document node
  identity, not "detect Tagify".
- Avo's polymorphic belongs-to submitting wrong field → fix
  `<template>` content inertness, not "detect Avo".

Library-shaped hacks accumulate and turn the driver into a museum of
workarounds that drift out of sync with each library's next release.

## 3. Performance is part of the contract

The reason this driver exists at all is that it's an order of
magnitude faster than booting a real browser per test. That speed
budget is non-negotiable.

When adding driver code:
- Hot paths (`record_action`, `find_css` / `find_xpath`, `dispatch_event`,
  every dom_op) should short-circuit cheaply when a feature is off.
  Cache env-var decisions at construction; don't re-read per call.
- DOM serialization (`Browser#html`) is expensive — it walks the whole
  document. Avoid serializing in hot paths; defer to write-time.
- JS-side allocations matter too. The `console.*` wrapper is per-call
  on every app log; the FormData iterator is per-form-submit. Keep the
  primitive-only fast path.
- Per-result O(N) scans (e.g. ancestor walks for visibility / template
  filtering) get hit hundreds of times per `find` on Avo-scale pages.
  Prefer constant-time gates or Nokogiri C-level helpers
  (`node.ancestors(selector).any?`) over hand-rolled walks.
- When in doubt, profile against the Avo / Forem / Redmine suites
  before shipping. A correctness fix that doubles the run time is a
  regression.
