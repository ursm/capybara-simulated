# v3 design

Goal: a JS-native DOM owned by V8, no Nokogiri tree, no per-DOM-op
Ruby↔V8 IPC, eligible for thread-mode parallel runs once a thin V8
binding lands. Carries v2's hard-won bridge.js mechanics (events,
MutationObserver, custom elements, virtual clock, location proxy,
fetch, …) forward into the new tree.

## Why

Measured v2 ceiling on Redmine system suite (102 s V8 / 117 s
QuickJS) vs Selenium real Chrome (77 s). v2 hits structural costs we
can't move:

- 14.6 % wall in `Nokogiri::XML::XPathContext#evaluate` (libxml2 via
  Ruby — already C, can't speed up much).
- ~20 % wall in `p_css` cascade / matcher (Ruby — Rust ext will
  help, but still Ruby-bridged).
- 11 % wall in GC (allocations on every `dom_op` arg / return).
- 3 % wall in mini_racer rendezvous (Ruby↔V8 mutex round-trips).

Plus a soft ceiling: `Capybara::Result#each` iterates Nokogiri while
JS-side timer callbacks mutate the same tree. v2's mini_racer
default mode hides the race via rendezvous serialisation; we
discovered (2026-05-11) that switching to `:single_threaded` (3.8×
cheaper IPC) immediately SIGSEGVs the smoke-spec timer test because
the libxml2 child-list pointer goes stale mid-iteration.

If the DOM lives in V8:
- Iteration and mutation are both in JS — no cross-language race.
- DOM ops are JIT'd by V8 (closer to real Chrome's Blink C++ for
  most observable workloads).
- mini_racer rendezvous count drops to once per Capybara action
  (visit / click / find / has_? / …) instead of once per `__dom`
  callback (currently 5,000+ per test).
- A `:single_threaded` thin binding becomes safe → linear thread
  scaling vs Selenium's process-only model.

The architecture is the same one v1 used (mini_racer + happy-dom).
v1 was 5× slower than v2 on shared specs, but the v1→v2 measurement
on 2026-05-11 showed v1's CPU work matched v2's almost exactly
(62 s user vs ~50 s user); the remaining 270 s of v1 wall was
mini_racer rendezvous *plus* happy-dom's bundle parse on every
reset, none of it intrinsic to the architecture.

## Non-goals (PoC scope)

- Layout engine. visibility stays cascade-driven via the same
  `class_hidden?` + p_css resolution v2 uses; we re-implement on
  the JS side or call back to Ruby once per page.
- Full WHATWG DOM. Capybara + Stimulus + Turbo surface area, not
  more.
- ES Module resolution that beats v2's. Same EsmRewriter, lifted
  into the JS layer.
- Selenium-equivalent multi-window. Out for now.

## Architecture

```
                        ┌────────────────────────────────┐
                        │  V8 Context (1 per Browser)    │
                        │                                │
                        │  document — root Element       │
                        │   ├ <html>                     │
                        │   │  ├ <head>…                 │
                        │   │  └ <body>…                 │
  Capybara::Simulated   │                                │
   ┌──────────────┐     │  bridge.js (carries over)      │
   │ Driver       │     │   - event dispatch              │
   ├──────────────┤     │   - MutationObserver            │
   │ Browser      │ ────┤   - virtual setTimeout clock    │
   ├──────────────┤     │   - custom-element registry     │
   │ Node         │     │   - location / history proxy    │
   └──────────────┘     │   - fetch / XHR via __rackFetch │
        │               │                                 │
        ▼               │  v3-only:                       │
  Ruby-side ops         │   - DomDocument / Element       │
   - visit              │   - querySelector / matches     │
   - click              │   - innerHTML setter / parse    │
   - find_xpath         │   - Cascade.resolve (port)      │
   - find_css           └──────────┬──────────────────────┘
   - …                             │
        │                          │ rare rendezvous
        ▼                          │   (only at Capybara
  one V8 call per                  │    action boundaries —
  Capybara action                  │    no __dom callbacks)
                                   ▼
                          Ruby host fns (unchanged):
                            - __rackFetch
                            - __locationAssign
                            - __setListenedType
                            - __setIntersectionObserverActive
                            - __csim_* (URL parse, atob, …)
```

## Migration shape (from v2)

Keep what we have, replace what's bridged:

| Concern               | v2                          | v3                              |
|-----------------------|-----------------------------|---------------------------------|
| Element nodes         | Nokogiri (Ruby)             | JS class (V8)                   |
| Element handles       | Integer → Nokogiri map      | Direct JS references            |
| `__dom(h, op, ...)`   | Per DOM op → Ruby           | Removed                         |
| querySelector         | Ruby Nokogiri / p_css       | JS-side matcher (port)          |
| Cascade               | Ruby p_css                  | JS-side port (later)            |
| MutationObserver      | `__mutations` Ruby buffer   | Pure JS                         |
| Event dispatch        | JS in bridge.js, mutates Ruby tree via `__dom` | JS only — mutates JS tree |
| setTimeout / clock    | JS in bridge.js, calls Ruby `__setTimersActive` | Same (no change) |
| fetch / XHR           | JS in bridge.js, calls Ruby `__rackFetch` | Same (no change) |
| HTML parsing on visit | Ruby Nokogiri parses, registers handles | Ruby fetches body, JS parses (see below) |
| Capybara `find_css`   | Ruby Nokogiri `at_css`      | One V8 call returning a JS node-ref or `null` |

## HTML parsing in v3

Three options ordered by effort:

1. **Pass raw HTML string to V8, JS parses.** Need a small HTML
   parser in JS — write our own (tag-soup style; we don't need
   spec-strict) or vendor a 5-10 KB minified parser. PoC can ship
   a "good enough for tests" parser that handles `<script>` / `<style>`
   / typical attribute syntax.
2. **Ruby Nokogiri parses, walks tree, builds JS structure via batch
   call.** One `Context#call('__buildTree', [array-of-node-descs])`
   per visit. Heavier per-visit cost but skips writing an HTML
   parser.
3. **Vendor parse5 or htmlparser2.** Robust, well-tested. ~50-80 KB
   minified. Means accepting a third-party JS lib.

PoC: option 2 (reuse Nokogiri, avoid writing a parser). Migrate to
option 1 later if `__buildTree` cost is significant.

## Iterator safety

The bug we hit with single_threaded mini_racer was: JS callback
mutates a tree the Ruby iterator is walking. In v3 there's no Ruby
iterator — Capybara walks via JS (e.g., `find_all` calls a JS
querySelectorAll which returns a static `NodeList`). Mutations
happen in JS. The iteration is JS-side and the mutation order is
defined by JS semantics. The libxml2 SIGSEGV class is gone.

## File layout

Same as v2, additive:

```
lib/capybara/simulated/
  v3_browser.rb       — replaces v2 Browser; talks to v8 only
  v3_runtime.rb       — V8 Context wrapper (single-threaded eligible)
vendor/js/
  v3_bridge.js        — v2 bridge.js + a JS-side Element / Document
                        / matcher / cascade port
```

Driver picks v2 or v3 via `CSIM_VERSION=v3` env or
`Driver.new(app, version: :v3)`. v2 stays the default during PoC.

## PoC milestones

1. **Branch + skeleton**: `lib/capybara/simulated/v3_browser.rb` /
   `v3_runtime.rb` / `vendor/js/v3_bridge.js`. Driver selector
   recognises `version: :v3`.
2. **Static HTML + querySelector**: visit with a static-body app,
   `find('#x').text` works through V8 round-trip.
3. **Form interactions**: `fill_in` / `click_button` /
   `click_link` against form fixtures.
4. **Event dispatch**: lift v2's bridge.js dispatch into v3 with
   JS-tree mutations.
5. **smoke_spec.rb passes on v3.**
6. **capybara_shared_spec.rb at parity or better than v2.**
7. **Hotwire (Stimulus + Turbo) e2e through v3.**
8. **Redmine system-test suite passes.**
9. **Single-threaded mini_racer (or thin V8 binding) enabled →
   measure perf vs Selenium and parallel scaling.**

## Risks

- **JS-side matcher is slower than libxml2 + p_css.** Profile early.
  If `querySelectorAll` becomes the bottleneck, port p_css to a JS
  Rust-via-WASM or call back to Ruby's p_css for matching only.
- **HTML parser quality**: tag-soup parsers miss edge cases real
  apps depend on (`<table>` body insertion mode, `<noscript>`
  rules). Mitigated by starting with the Nokogiri-driven option.
- **Cascade port**: Capybara's `:hidden` / `:visible` filter goes
  through cascade. Ruby p_css is mature; rewriting in JS is a
  meaningful chunk. Can defer by calling back to Ruby once per
  visible? check (still cheap compared to today's per-element
  __dom barrage).
- **Stimulus / Turbo's reliance on real DOM**: certain WHATWG DOM
  details (text-node merging, NodeFilter, range API) need to be
  honoured. v2's bridge.js already implements a lot of this on top
  of __dom; reroute to v3's JS tree.

## What v2 keeps

- All the bridge.js mechanics that don't depend on the Ruby tree:
  event dispatch (rewired to v3 tree), MO delivery, custom-element
  registry, virtual clock, location proxy, fetch shim, EsmRewriter,
  Snapshot warmup.
- The Driver / Node interfaces — Capybara user code is unchanged.

## What v2 throws away

- Nokogiri as DOM source of truth.
- p_css as querying / cascade engine (initially — may come back).
- `__dom` host fn surface. The remaining Ruby host fns are coarse:
  `__rackFetch`, `__locationAssign`, `__setTimersActive`,
  `__setListenedType`, `__setIntersectionObserverActive`, `__csim_*`
  polyfills.

Don't merge v3 to `main` until milestones 5-6 (smoke + shared spec
parity) are met. Until then, v3 is a `v3` branch shipped behind an
env var.
