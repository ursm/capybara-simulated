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
(`spec/wpt_spec.rb` — the same tests Chromium / Firefox hold themselves
to). Fix the spec contract and every library built on it works for free.

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

1. **It needs a subsystem we deliberately don't model.** A layout /
   rendering engine (visual hit-testing, `getBoundingClientRect`
   truthiness, viewport-clip visibility, `display: contents` / table
   layout), a real async runtime / streams, or IDNA / Unicode-host /
   legacy-multibyte encoding tables.
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
exclusion.

A bounded, documented conformance gap is acceptable **only** when it's
the deliberate cost of a load-bearing design choice and the alternative
costs more than it's worth — e.g. `HTMLCollection extends Array` (for
framework array-iteration compat) forces `length` into
`getOwnPropertyNames`. List and justify these explicitly; don't let them
multiply.

Caveat: "spec-correct" still means "what real browsers actually do."
Where the spec is silent or browsers diverge from it, match Chromium /
Firefox observable behavior (rule 2). A behavior real browsers *do* have,
that an app depends on, is in scope and must work.

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
