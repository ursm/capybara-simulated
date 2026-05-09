# capybara-simulated — engineering principles

This driver runs Capybara tests in-process via QuickJS + Nokogiri. The
codebase has a few load-bearing rules; deviations have repeatedly cost
us regressions or paint us into a corner.

## 1. Real-browser test parity is the bar

Any test that passes in a real browser must pass here too, with the
single exception of tests that fundamentally require a layout engine
(visual hit-testing, `getBoundingClientRect` truthiness, viewport-clip
visibility, `display: contents` / table layout edge cases, …). Those
are out of scope.

Everything else — DOM semantics, event ordering, form serialization,
custom-element lifecycle, MutationObserver delivery, lifecycle events
— must match. If a test works in cuprite/selenium against the same
HTML and JS, the failure is on us.

A green CI count is not the goal: it's the floor. A failing
real-browser-equivalent test is a driver bug, not a test problem.

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
