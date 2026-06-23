# capybara-simulated

A lightweight Capybara driver that runs JavaScript against an
in-process JS-resident DOM, with no Chrome. Forms submit through
`Rack::MockRequest`, inline `<script>` and event handlers run, and the
Capybara DSL is unchanged.

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
engine: **pixel layout** (`getBoundingClientRect()` returns zeros,
`elementFromPoint()` isn't implemented, so visual hit-testing, coordinate
drag-and-drop, and sticky-scroll math don't work) and **screenshots**.

Most of the rest runs in-process — including the things that usually mean
"you need a real browser": **`within_frame`**, **multiple windows / tabs**,
**WebSocket + Action Cable**, **EventSource**, and **Web Workers** all work.
Each has constraints (JS engine, settle-timing, no layout); see
[Capabilities & limits](#capabilities--limits).

## Status

The architecture and behaviour are stable. Correctness is held to two
bars. A vendored subset of
[web-platform-tests](https://github.com/web-platform-tests/wpt) — the
same DOM / HTML tests Chromium and Firefox hold themselves to — runs as
a conformance gate. And each target app (Redmine / Forem / Avo /
Mastodon / Discourse) runs its full system suite against the driver in
[capybara-simulated-vs-world](https://github.com/ursm/capybara-simulated-vs-world)
as an integration check.

The remaining gaps are the layout / pixel-geometry features the driver
deliberately doesn't simulate — the same set Selenium escapes via
screenshots (see [Capabilities & limits](#capabilities--limits)).

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
gem 'rusty_racer', '>= 0.1.9'  # V8 (JIT, fastest per spec) — default
gem 'quickjs', '>= 0.18'       # QuickJS (interpreter, smaller per-VM RAM —
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

Require the test-framework integration in your `spec_helper` /
`rails_helper` (RSpec) or `test_helper` /
`application_system_test_case.rb` (Minitest):

```ruby
require 'capybara/simulated/rspec'     # RSpec
require 'capybara/simulated/minitest'  # Minitest / Rails system tests
```

With `CSIM_TRACE_DIR=/path/to/dir` set, each example that recorded a
trace is written to `<dir>/<slug>.json` after it runs; both integrations
are inert when the env var is unset.

```sh
CSIM_TRACE_DIR=tmp/csim-traces bundle exec rspec spec/system
```

The metadata block on each trace includes `title`, `file`, `outcome`
(`passed` / `failed`), and the exception message — enough to index a
CI artifact directory by failure.

### Viewing traces

The recorded JSON stays plain data; to look at one, render it into a
self-contained HTML viewer with the bundled CLI:

```sh
capybara-simulated trace tmp/csim-traces/checkout_flow.json
# wrote /tmp/checkout_flow.html   (then opens it in your browser)
```

By default the HTML is written to a temp file and opened in your
browser. The viewer works straight from `file://` — the trace JSON is
embedded inline, so no server is needed — and shows a step-by-step UI: a
timeline of actions, and per step the URL before/after, console output,
network requests, the error, and a rendered preview of the post-action
DOM snapshot. Its **Load JSON…** button / drag-and-drop swaps in any
other trace file.

`-o PATH` writes the HTML somewhere specific (`-o -` to stdout);
`--no-open` skips launching the browser. Browser launching uses
[launchy](https://rubygems.org/gems/launchy) when it's installed
(`gem 'launchy'`, recommended for reliable cross-platform / WSL opening)
and falls back to the platform opener (`xdg-open` / `open` / `start`)
otherwise.

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

## Capabilities & limits

Most features run in-process; the notes below are mostly "works, but…",
followed by the short list of things that need a real browser **by design**.

### Works, with constraints

- **`within_frame` / `switch_to_frame`** (V8 engine) — each `<iframe>` runs
  its own scripts in its own per-frame realm; the DSL routes finds, reads,
  interactions, `evaluate_script`, and navigation into the active frame,
  nested frames included — the target frame's realm is rebuilt from the
  fetched document, the top page untouched. QuickJS has no nested browsing
  context, so `within_frame` raises there.
- **Multiple windows / tabs** (both engines) — each window is its own
  Browser + JS VM (own DOM, sessionStorage, history; cookies + localStorage
  shared). `open_new_window` / `within_window` / `switch_to_window` /
  `window_opened_by` drive them; JS `window.open` opens a real window,
  `window.opener` links back, and `postMessage` crosses windows. Only the
  active window's event loop runs, so a message is delivered when you switch
  to its window. `target="_blank"` opens with no opener (modern-browser
  default). `postMessage` carries real structured data (not a lossy JSON
  hop) — `Map` / `Set` / `Date` / `BigInt` / typed arrays / cyclic graphs all
  round-trip on V8 — and a `transfer`-list buffer moves **zero-copy** (backing
  store by token, source detached); only bare `undefined` collapses to `null`
  (Ruby has no distinct `undefined`). Window viewport APIs (`maximize` /
  `fullscreen` / pixel-exact `resize_to`) are no-ops (no layout engine).
- **WebSocket + Action Cable** — `new WebSocket(url)` works in-process over
  the `rack.hijack` socket the Rack app hijacks (hand-rolled RFC6455, including
  subprotocol negotiation). The real `@rails/actioncable` consumer connects,
  subscribes, and receives broadcasts, so `turbo_stream_from` live updates
  work. Constraints: server
  pushes land at settle (not instant); the Cable app must use the **async /
  in-process** adapter (a real Redis adapter needs real Redis); binary frames
  are V8-only (QuickJS corrupts raw bytes across the host boundary — text,
  hence Action Cable, works on both engines). `EventSource` and Web Workers
  are likewise real (background reader threads draining at settle).
- **`fetch` / XHR** — synchronous through Rack: HTML / JSON round-trips work,
  but there's no streaming, no `Request#body` ReadableStream, and no
  concurrent requests.
- **`:hover` / `:focus-within`-gated content** — reachable two ways: call
  `element.hover` explicitly (we track the most-recently-hovered element and
  propagate `:hover` up its chain), or rely on the candidate-chain fallback
  (when the stateless cascade reports `display: none`, we re-evaluate with the
  candidate itself in the `:hover` set). Symmetric peers — N rows each with
  `tr:hover .icon` revealing `.icon`, queried as a bare `find('.icon')` —
  reveal all and Capybara raises `Capybara::Ambiguous`; scope the test
  (`find('tr', text: 'foo').hover` then `find('.icon')`), which is also more
  robust against real-browser flake.

### Out of scope (by design — use Selenium / Cuprite)

- **Layout / pixel geometry.** `visible?` and `Node#style` consult the CSS
  cascade and the inline `style` attribute, but `getBoundingClientRect()`
  returns zeros and `elementFromPoint()` isn't implemented. Click offsets work
  for fixture-style absolute / relative positioning (ancestor-summed
  `top`/`left`); position-via-layout (Dragula drops, sticky-header scroll math,
  viewport-clip visibility) needs a real browser.
- **Screenshots.**

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

## License

[MIT](LICENSE).
