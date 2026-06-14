# capybara-simulated

A lightweight Capybara driver that runs JavaScript against an
in-process JS-resident DOM, with no Chrome. Forms submit through
`Rack::MockRequest`, inline `<script>` and event handlers run,
MutationObserver / custom elements / `<template>` / Shadow DOM /
Trix / Stimulus / Turbo all work, and the Capybara DSL is unchanged.

The DOM lives entirely inside the JS engine — V8 via
[rusty_racer](https://github.com/ursm/rusty_racer) or QuickJS via
[quickjs.rb](https://github.com/hmsk/quickjs.rb), whichever is
installed — with no Nokogiri tree on the Ruby side. Capybara finds
resolve through css-select (CSS) and xpathway (XPath) running in the
same context as the page's JS, so `find` / `has_css?` / `within` see
exactly the tree the app sees.

## Is it a fit?

**A good fit when** your tests are JavaScript-driven but don't depend on
visual layout:

- **Fast, in-process** — no Chrome to boot, no WebDriver, no Node
  toolchain. About **1.9× faster** than a headless browser on
  server-rendered / Hotwire apps, and roughly at parity on JS-heavy SPAs
  (with rusty_racer).
- **Deterministic** — a virtual clock and synchronous in-process execution
  remove the wall-clock timing, network, and rendering races that make
  headless-browser suites flaky.
- **Real front-end JS runs**: inline `<script>` + event handlers,
  MutationObserver, custom elements, `<template>`, Shadow DOM, ES modules
  + importmap, **Hotwire (Stimulus + Turbo)**, Trix.
- **Drop-in**: the Capybara DSL is unchanged — register `:simulated` and
  go. Just this gem plus one JS-engine gem.
- **Held to spec**: a vendored
  [web-platform-tests](https://github.com/web-platform-tests/wpt)
  conformance gate plus five real app suites (see [Status](#status)).

**Reach for a real browser** (Selenium / Cuprite) **when** your tests need
what this driver doesn't simulate **by design** — there's no rendering
engine or real network stack, the same ground Selenium covers via a real
browser:

- **Pixel layout** — `getBoundingClientRect()` returns zeros and
  `elementFromPoint()` isn't implemented, so visual hit-testing,
  coordinate drag-and-drop, and sticky-scroll math don't work.
- **Real networking** — `fetch` / XHR are synchronous through Rack: no
  streaming, no concurrency, no WebSocket.
- **Screenshots**.

**`within_frame` / `switch_to_frame`** work on the V8 (rusty_racer) engine:
each `<iframe>` runs its own scripts in its own per-frame realm, and the DSL
routes finds, reads, interactions, `evaluate_script`, and self-targeted
navigation (a link or form submit inside the frame) into the active frame —
nested frames included. (QuickJS keeps a same-realm fallback, so
`within_frame` is V8-only.)

**Multiple windows / tabs** work on both engines: each window is its own
Browser + JS VM (own DOM, sessionStorage, history; cookies + localStorage
shared). `open_new_window` / `within_window` / `switch_to_window` /
`window_opened_by` drive them, and JS `window.open` opens a real window,
`window.opener` points back to the opener, and `postMessage` is delivered
across windows. (`target="_blank"` defaults to no-opener, matching modern
browsers; cross-window `postMessage` data is JSON-shaped, not a full
structured clone.)

See [Known limits](#known-limits) for the full picture.

## Status

The architecture and behaviour are stable. Correctness is held to two
bars. A vendored subset of
[web-platform-tests](https://github.com/web-platform-tests/wpt) — the
same DOM / HTML tests Chromium and Firefox hold themselves to — runs as
a conformance gate. And each target app (Redmine / Forem / Avo /
Mastodon / Discourse) runs its full system suite against the driver in
[capybara-simulated-vs-world](https://github.com/ursm/capybara-simulated-vs-world)
as an integration check.

The remaining gaps need a real layout engine (`elementFromPoint`,
truthy `getBoundingClientRect`, viewport-clip visibility, `display:
contents` table edge cases) — the same set Selenium escapes via
screenshots and this driver deliberately doesn't simulate.

## Install

```ruby
gem 'capybara-simulated', group: :test
gem 'rusty_racer', group: :test  # JS engine — pick one
```

`bundle install`. Requires Ruby ≥ 3.3. The gem ships its JS bridge
under `lib/capybara/simulated/js/` and the vendored JS deps under
`vendor/js/`, so there's no Node toolchain at consume time.

### JS engine

The gem treats the JS engine as a soft dependency. Pick one of:

```ruby
gem 'rusty_racer'         # V8 (JIT, fastest per spec) — default
gem 'quickjs', '>= 0.18'  # QuickJS (interpreter, smaller per-VM RAM —
                          # wins when scaling parallel workers under
                          # a fixed memory budget)
```

The V8 engine comes from [rusty_racer](https://github.com/ursm/rusty_racer),
a rusty_v8-based Ruby binding with the native ES Module API,
`ScriptCompiler::CachedData` snapshots, and per-frame realm contexts the
driver builds on.

The engine is auto-detected at boot; if both gems are present V8 wins.
Override explicitly with `CSIM_JS_ENGINE=v8|quickjs`
or `Capybara::Simulated::Driver.new(app, js_engine: :quickjs)`.

## Use

`require 'capybara/simulated'` registers the `:simulated` driver.

### RSpec

```ruby
# spec/spec_helper.rb (or spec/rails_helper.rb)
require 'capybara/rspec'
require 'capybara/simulated'

Capybara.javascript_driver = :simulated
# Optional: use :simulated for non-JS specs too.
# Capybara.default_driver = :simulated
```

Tests tagged `js: true` (or `type: :system, js: true` in Rails) run
in the driver:

```ruby
RSpec.describe 'sign-in', type: :system, js: true do
  it 'logs the user in' do
    visit '/login'
    fill_in 'Email',    with: 'alice@example.com'
    fill_in 'Password', with: 'hunter2'
    click_button 'Log in'
    expect(page).to have_text('Welcome, Alice')
  end
end
```

For Rails system tests, set the driver via `driven_by`:

```ruby
RSpec.describe 'sign-in', type: :system do
  before { driven_by :simulated }
  # ...
end
```

### Minitest

`Capybara.javascript_driver` is RSpec-only — `ActionDispatch::SystemTestCase`
ignores it. Set the driver explicitly:

```ruby
# test/application_system_test_case.rb
require 'capybara/minitest'
require 'capybara/simulated'

class ApplicationSystemTestCase < ActionDispatch::SystemTestCase
  driven_by :simulated
end
```

### Plain Capybara DSL (no framework)

```ruby
require 'capybara/dsl'
require 'capybara/simulated'

Capybara.app = MyRackApp
Capybara.default_driver = :simulated

include Capybara::DSL

visit '/'
click_link 'About'
puts page.text
```

## Trace

Each Capybara action (`visit`, `click`, `set`, …) is recorded as a step
in a per-test trace: URL before / after, console output and network
requests during the step, plus elapsed and per-step durations. On
action failure (and only then, by default) the post-action DOM is
captured too.

Recording is **on by default** — fully in-memory, no files written
unless you opt in via `CSIM_TRACE_DIR`. Wall-time overhead is
run-to-run-variance equivalent because the expensive part — DOM
serialization — only fires on action error.

### Modes (`CSIM_TRACE=…`)

| value | recording | DOM snapshot |
|---|---|---|
| (unset) / `on-failure` | yes (default) | per step on action error only |
| `full` | yes | after every action — debug-heavy |
| `off` | nothing recorded, `record_action` early-exits | — |

### Inspecting traces

In an after-hook:

```ruby
after(:each) do |example|
  if example.exception
    trace = page.driver.current_trace
    puts trace.steps.last.dom_after  # final-state HTML
    puts trace.steps.flat_map(&:console).map {|c| "#{c[:severity]} #{c[:message]}" }
  end
end
```

### File output

Set `CSIM_TRACE_DIR=/path/to/dir` to enable file output. The bundled
RSpec hook ([`csim_rspec.rb`](https://github.com/ursm/capybara-simulated-vs-world/blob/main/support/csim_rspec.rb))
writes `<example slug>.json` into that directory after each test;
mirror it in `application_system_test_case.rb`'s teardown for
Minitest.

```sh
CSIM_TRACE_DIR=tmp/csim-traces bundle exec rspec spec/system
```

The metadata block on each trace includes `title`, `file`, `outcome`
(`passed` / `failed`), and the exception message — enough to index a
CI artifact directory by failure.

### Programmatic

For finer control, call `driver.start_tracing(...)` /
`driver.stop_tracing(path: ...)`. The shape mirrors
`capybara-playwright-driver`:

```ruby
RSpec.describe 'flaky payment flow', type: :system, js: true do
  it 'completes a checkout' do
    page.driver.start_tracing(case_id: 'PAY-1431')
    visit '/checkout'
    fill_in 'Card', with: '4242424242424242'
    click_button 'Pay'
    expect(page).to have_text 'Thank you'
  ensure
    page.driver.stop_tracing(path: "tmp/traces/#{example.full_description}.json")
  end
end
```

### Trace JSON schema

```jsonc
{
  "version": 1,
  "metadata": { "title": "...", "outcome": "passed", "...": "..." },
  "steps": [
    {
      "index":       0,
      "kind":        "visit",       // visit / click / set / send_keys / select / submit / refresh / go_back / go_forward
      "description": "visit /checkout",
      "url_before":  null,
      "url_after":   "http://www.example.com/checkout",
      "dom_after":   null,          // populated only on action error or in `full` mode
      "console":     [{ "severity": "info", "message": "Stripe.js loaded" }],
      "network":     [{ "method": "GET",    "url": "/checkout", "status": 200 }],
      "elapsed_ms":  0,
      "duration_ms": 38,
      "error":       null
    }
  ]
}
```

## Performance characteristics

The driver builds a base snapshot once per process — the bundled
bridge plus the vendored JS deps, as a V8 `Snapshot` for rusty_racer or
bytecode for QuickJS. On V8 that snapshot warms a single long-lived
isolate whose context is reset to a clean realm per navigation
(`Context#reset`); on QuickJS each navigation checks a freshly
snapshot-loaded VM out of a small pre-warmed pool. Either way, every
navigation lands on a clean, warm JS context near-instantly.

**Wall time is sensitive to whether the app uses Turbo Drive**,
because navigation simulates real-browser semantics:

| navigation source | what happens |
|---|---|
| `visit(...)`, `refresh`, programmatic `location.assign` | full reload — fresh JS Context, scripts re-evaluated |
| link click *with Turbo Drive loaded* | Turbo intercepts, body-swap via JS, **JS context preserved** |
| link click *without Turbo Drive* | full reload (anchor default action) |
| form submit *with Turbo Drive loaded* | Turbo intercepts (turbo-frame or page-level), body-swap |
| form submit *without Turbo Drive* | full reload |

So Turbo Drive apps stay fast even with click-heavy tests; non-Turbo
apps pay full-reload cost per click — exactly mirroring what the
production site does.

### Library snapshot policy

Per visit, `<script src>`-referenced libraries (jQuery, Stimulus,
…) re-evaluate fresh against the new page. They are **not** baked
into a per-app snapshot — preserving library state across page
navigations is what real browsers don't do, and trying to do it
broke `$.ready` Callbacks queues whose user-app callbacks
referenced page-specific DOM.

### Other factors

- **`<script src>` parsing** dominates `visit` on JS-heavy pages.
  Each external script is fetched through the in-process Rack app,
  compiled, and run in the JS engine with bytecode cache hits from
  the base snapshot warmup.
- **CSS cascade resolution**: stylesheets are parsed once per distinct
  set of sources and cached content-addressably, so repeat visits and
  subsequent finds on the same page reuse the resolved cascade instead
  of re-parsing.
- **DOM ops stay inside the JS engine** — find / has_? / event
  dispatch never cross the Ruby ↔ JS boundary for the actual tree
  walk; only the resulting handle ids do. Modify-heavy tests
  (SortableJS dragging thousands of items) run at JS-engine speed,
  not at host-call-IPC speed.
- **Polling** (Capybara `default_max_wait_time`) advances a *virtual*
  JS clock — timers fire as polling steps the clock forward, not in
  real time. A page that schedules `setTimeout(2000, x)` doesn't block
  for 2 s; the callback fires once polling has advanced the clock past
  it.

## Known limits

- **No layout engine.** `visible?` and `Node#style` consult the CSS
  cascade and the inline `style` attribute, but
  `getBoundingClientRect()` returns zeros and `elementFromPoint()`
  isn't implemented. Click offsets work for fixture-style absolute /
  relative positioning (ancestor-summed `top`/`left`); position-via-
  layout (Dragula drops, sticky-header scroll math) needs a real
  browser.
- **`:hover` / `:focus-within`-gated content** is reachable two ways:
  call `element.hover` explicitly (we track the most-recently-hovered
  element and propagate `:hover` up its chain), or rely on the
  candidate-chain fallback (when stateless cascade reports
  `display: none`, we re-evaluate with the candidate itself in the
  `:hover` set). Symmetric peers — N rows each with `tr:hover .icon`
  revealing `.icon`, queried as bare `find('.icon')` — reveal all and
  Capybara raises `Capybara::Ambiguous`. Scope the test (`find('tr',
  text: 'foo').hover` then `find('.icon')`) — also more robust
  against real-browser flake.
- **`fetch` is synchronous-via-Rack** — HTML / JSON round-trips work
  but there's no real network, no streaming, no `Request#body`
  ReadableStream, and no concurrent requests. XHR is implemented
  with the same Rack pass-through.
- **WebSocket, screenshots, and drag pixel coordinates** are out of
  scope by design — use Selenium / Cuprite. (EventSource and Web
  Workers *are* implemented.)
- **`within_frame` / `switch_to_frame`** work on the V8 engine: each
  `<iframe>` runs in its own per-frame realm and the DSL routes finds,
  reads, interactions, `evaluate_script`, and self-targeted navigation
  (link / form submit) into the active frame (nested frames included) — the
  frame's realm is rebuilt from the fetched document, leaving the top page
  untouched. `_top` navigates the main page; a `_parent` target from a
  frame nested ≥2 levels falls back to navigating the main page, and
  cross-origin frame locality resolves against the main origin. QuickJS has
  no nested browsing context, so `within_frame` raises there.
- **Multiple windows / tabs** work on both engines: each window is its own
  Browser + JS VM (own DOM, sessionStorage, history; cookies + localStorage
  shared across windows). `open_new_window` / `within_window` /
  `switch_to_window` / `window_opened_by` drive them; JS `window.open` opens
  a real window, `window.opener` links back, and `postMessage` is routed
  across windows (delivered as a `message` event when the target window next
  settles). Caveats: `target="_blank"` opens with no opener (modern-browser
  no-opener default); cross-window `postMessage` data is JSON-shaped, not a
  full structured clone (no `DataCloneError`, `undefined`→`null`); and only
  the active window's event loop runs, so a message is delivered when you
  switch to its window. Window viewport APIs (`maximize` / `fullscreen` /
  pixel-exact `resize_to`) are no-ops — no layout engine.

## Architecture

- `lib/capybara/simulated/js/src/` — the entire DOM lives here, split
  across ~50 ES modules bundled into `bridge.bundle.js` (esbuild; no
  Node toolchain at consume time). `Document` / `Element` / `Text` /
  `DocumentFragment` / `ShadowRoot` classes; event dispatch
  (capture / target / bubble with shadow retargeting, via
  `dispatchEvent(target, event)`); a virtual `setTimeout` /
  `setInterval` / `requestAnimationFrame` clock; MutationObserver;
  custom-element registry; `Range` / `Selection`; and the cascade
  resolver for `display` / `visibility` / `text-transform`. Capybara's
  finds run through the vendored css-select (with css-what / css-tree)
  for CSS and xpathway for XPath — both true third parties under
  `vendor/js/`, executing in the same context as the page's JS.
- `lib/capybara/simulated/browser.rb` — Rack client, history stack,
  modal handler queue, virtual-clock anchor, trace recorder. Owns
  the JS runtime via `V8Runtime` or `QuickJSRuntime`. The hot
  operations (`find_css` / `find_xpath` / DOM ops / event dispatch)
  are single-`Context#call` round-trips returning handle id arrays;
  per-result iteration stays Ruby-side.
- `lib/capybara/simulated/v8_runtime.rb` / `quickjs_runtime.rb` —
  per-engine wrappers, common bits in `runtime_shared.rb`. The V8
  base-snapshot (and the QuickJS bytecode equivalent) bakes in the
  bundled bridge + vendored deps, so a per-navigation context reset
  (V8) or pooled VM checkout (QuickJS) is sub-millisecond.
- `lib/capybara/simulated/driver.rb` — Capybara `Driver::Base`
  surface (visit / find / execute_script / window handling / modal /
  tracing API).
- `lib/capybara/simulated/node.rb` — `Driver::Node` over a
  `(handle_id, context_gen)` pair so a handle from a pre-rebuild
  Context can't ghost into the next one.

## ES modules + importmap

`<script type="module">` and `<script type="importmap">` work the
same way they do in a real browser: bare specifiers resolve through
the importmap, relative paths resolve against the importer's URL,
and every load (including dynamic `import(...)`) routes back through
the in-process Rack app. No bundling step, no Node toolchain.

The standard importmap-rails layout works as-is:

```erb
<%= javascript_importmap_tags %>
<!-- emits:
  <script type="importmap">{ "imports": { "application": "/assets/application-...js", ... } }</script>
  <script type="module">import "application"</script>
-->
```

## Hotwire (Stimulus + Turbo)

Stimulus and Turbo work both via UMD (classic `<script src>`) and via
the standard ESM bundles imported through importmap. For
importmap-rails apps, no changes are needed:

```ruby
# config/importmap.rb
pin '@hotwired/stimulus'
pin '@hotwired/turbo'
```

`window.fetch` routes through Rack, so Turbo's frame fetch and
link-action POSTs round-trip the test app.

## License

[MIT](LICENSE).
