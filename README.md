# capybara-simulated

A lightweight Capybara driver that runs JavaScript against a
[Nokogiri](https://nokogiri.org/)-backed DOM. The driver sits between
`rack-test` (zero JS) and full headless browsers like cuprite/selenium:
in-process tests, no Chrome, inline `<script>` and event handlers run,
the Capybara DSL works, and forms submit through `Rack::MockRequest`.

The JavaScript engine is pluggable: pick
[QuickJS](https://github.com/hmsk/quickjs.rb) (interpreted, low
Ruby↔JS overhead), [V8 via mini_racer](https://github.com/rubyjs/mini_racer)
(JIT-fast pure JS), or `none` (no `<script>` execution — rack-test
parity with full DOM/forms/cookies). All three are soft dependencies.

## Status

Capybara 3.40's shared `Capybara::SpecHelper.spec` suite runs
deterministically green at ~72 seconds: 1499 examples, 0 failures,
34 pending (vs Selenium's ~5 minutes for the same suite). The runner
filters the unsupported-capability tags (`about_scheme`, `frames`,
`screenshot`, `scroll`, `server`, `spatial`) and a few classes of
test marked pending with a documented reason — see
[`spec/capybara_shared_spec.rb`](spec/capybara_shared_spec.rb).
The remaining pending tests all need `elementFromPoint()`, i.e. a
real layout engine: drag-and-drop, `#obscured?`, `#all` with the
`obscured` filter, and a couple of `style`-filter edge cases.

The `:css`, `:hover`, and `:download` capabilities run in full — the
cascade resolver from [`p_css`](https://github.com/ursm/p_css) handles
real stylesheet rules, `Browser#hover` plumbs an explicit hover anchor
through the cascade for `:hover` rules, and `<a download>` clicks
persist the body to `Capybara.save_path`. Click offsets
(`element.click(x:, y:)`) work without a real layout engine:
`clientX`/`clientY` are computed by ancestor-summing the elements'
computed `top`/`left`. Truthful for fixture-style markup that arranges
click targets through explicit absolute / relative positioning.

## Install

```ruby
gem 'capybara-simulated', group: :test

# Pick a JS engine — one or both, or neither.
gem 'quickjs',    '>= 0.17.0.pre', group: :test  # interpreted
gem 'mini_racer',                  group: :test  # V8 (JIT)
```

Then `bundle install`. The gem ships its JS bridge under `vendor/js/`,
so there is no Node toolchain at consume time.

With both gems installed the driver picks QuickJS by default. Override
per `Driver.new` or globally via env:

```ruby
Capybara::Simulated::Driver.new(app, js_engine: :v8)
# or
CSIM_JS_ENGINE=v8 bundle exec rspec
```

Use `js_engine: :none` (or omit both gems) to disable script execution
entirely — Capybara's `rack-test` behavior, but with a Nokogiri-parsed
DOM and our matchers / event semantics. Useful for fast scans of
JS-independent flows and for isolating "does this reproduce without
JS?" bugs.

## Use

`require 'capybara/simulated'` registers the `:simulated` driver.

### RSpec

```ruby
# spec/spec_helper.rb (or spec/rails_helper.rb)
require 'capybara/rspec'
require 'capybara/simulated'

Capybara.javascript_driver = :simulated
# Optional: make :simulated the default for non-JS specs too.
# Capybara.default_driver = :simulated
```

Tests tagged `js: true` (or `type: :system, js: true` in Rails) will run
in the simulated driver:

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

For a Rails system test, set the driver in `before_setup` /
`driven_by`:

```ruby
RSpec.describe 'sign-in', type: :system do
  before { driven_by :simulated }
  # ...
end
```

### Minitest

`Capybara.javascript_driver` is RSpec-only — `ActionDispatch::SystemTestCase`
ignores it and `Capybara::Minitest::Test` has no `js: true` metadata
mechanism. Set the driver explicitly:

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

### Extra QuickJS feature flags

The runtime pins `URL`, `TextEncoder`/`TextDecoder`, and `crypto.randomUUID`
by default — the minimum a Hotwire-shaped page needs. Other QuickJS
polyfills (`Intl`, `Blob`/`File`, …) are opt-in: register the driver
with the extras you need.

```ruby
require 'quickjs'
require 'capybara/simulated'

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app, features: [Quickjs::POLYFILL_INTL])
end
```

`POLYFILL_INTL` is intentionally out of the default. It loads FormatJS
locale tables + IANA TZ bytecode and accounts for ~99% of VM construction
cost (~140 ms vs ~0.5 ms for the rest of the default-feature VM); apps
that don't reach for `Intl.DateTimeFormat`/`NumberFormat` shouldn't pay
for it. Bundles that *do* reach for `Intl` during module init (Avo's
flatpickr, luxon-driven date pickers, …) will throw `ReferenceError:
Intl is not defined` — opt in then.

See [`Quickjs.constants`](https://github.com/hmsk/quickjs.rb) for the
full list. `FEATURE_TIMEOUT` intentionally isn't honoured — the driver
runs JS timers on a virtual clock so test runs stay deterministic.

## Trace

Each Capybara action (`visit`, `click`, `fill_in`, …) can be recorded
as a step in a per-test trace: the URL before / after, a full DOM
snapshot at the end of the step, console output and network requests
that happened during it, plus elapsed and per-step durations. Output
is one JSON file per test — downstream tooling can build whatever
viewer it wants on top.

### Auto mode

Set `CSIM_TRACE_DIR=/path/to/dir` and trace recording starts on the
first action of every system test, then writes `<example slug>.json`
into the directory after the test finishes. The bundled
[`csim_rspec.rb`](https://github.com/ursm/capybara-simulated-vs-world/blob/main/support/csim_rspec.rb)
provides the RSpec hook; for Minitest, mirror it in
`application_system_test_case.rb`'s teardown.

```sh
CSIM_TRACE_DIR=tmp/csim-traces bundle exec rspec spec/system
```

The metadata block on each trace includes `title`, `file`, `outcome`
(`passed` / `failed`), and the exception message if the example
failed — enough to index a CI artifact directory by failure.

### Programmatic mode

For finer-grained control (only trace specific examples, attach
custom metadata, persist to a non-default location), call
`driver.start_tracing(...)` / `driver.stop_tracing(path: ...)`. The
shape mirrors `capybara-playwright-driver` so suites can swap drivers
without rewriting their hooks.

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
      "kind":        "visit",       // visit / click / fill_in / set / refresh / go_back / …
      "description": "/checkout",
      "url_before":  null,
      "url_after":   "http://www.example.com/checkout",
      "dom_after":   "<!DOCTYPE html>…",
      "console":     [{ "severity": "info", "message": "Stripe.js loaded" }],
      "network":     [{ "method": "GET",    "url": "/checkout", "status": 200 }],
      "elapsed_ms":  0,
      "duration_ms": 38,
      "error":       null
    }
  ]
}
```

The previous step's `dom_after` is the implicit "before" for the
next step; only the post-action snapshot is stored to keep the file
size manageable. Console and network entries are scoped to whichever
step was active when they happened.

## Performance characteristics

`Quickjs::VM.new` releases the GVL during runtime construction, so
`capybara-simulated` keeps a small process-wide pool of pre-warmed VMs
(4 background warmer threads, capacity 6). Each navigation that needs
a fresh JS context checks one out instantly instead of paying ~140 ms
on the foreground thread; `Quickjs::VM.new` without `POLYFILL_INTL` is
~0.5 ms anyway, so the pool barely matters for default-feature apps.

**Wall time is sensitive to whether the app uses Turbo Drive**, because
of how navigation simulates real-browser semantics:

| navigation source | what happens |
|---|---|
| `visit("/foo")`, `refresh`, programmatic `location.assign` | full reload — fresh VM, scripts re-evaluated |
| link click *with Turbo Drive loaded* | Turbo intercepts, body-swap via JS, **JS context preserved** |
| link click *without Turbo Drive* | full reload (anchor default action) |
| form submit *with Turbo Drive loaded* | Turbo intercepts (turbo-frame or page-level), body-swap |
| form submit *without Turbo Drive* | full reload (anchor default action) |

So Turbo Drive apps stay fast even with click-heavy tests; non-Turbo
apps pay full-reload cost per click — exactly mirroring what the
production site does.

Other things that affect wall time:

- **Per-test framework cost** is small. RSpec + Capybara + Rails boot is
  ~3–4 s in cold suites, identical to other drivers.
- **`<script src>` parsing** dominates `visit` on JS-heavy pages. Each
  external script is fetched through the in-process Rack app, parsed,
  and run in QuickJS *interpreted* (no JIT). Bytecode is cached by
  source hash, so the second visit to the same bundle replays in ~1 ms.
  Order of magnitude per cold visit:

  | page profile                          | typical cold `visit` |
  |---------------------------------------|----------------------|
  | inline scripts only, ~10 KB JS        |  50–150 ms           |
  | a Hotwire / Stimulus app, ~200 KB JS  | 400 ms – 1 s         |
  | React-on-Rails / Forem, 18+ bundles   | 4–6 s                |

  Linear-ish in bundle bytes, plus a fixed cost per microtask / promise
  hop because each re-enters Ruby for `__deliverMutations` and timer
  drains.
- **CSS cascade build** (via [`p_css`](https://github.com/ursm/p_css))
  is a one-shot per stylesheet *set*, cached by URL fingerprint and
  shared across pages with the same bundle. Avo (single 285 KB Tailwind
  bundle) → ~330 ms; Forem (4 stylesheets, 688 KB) → ~1.8 s the first
  time, ~0 ms thereafter.
- **DOM ops cross the Ruby↔JS bridge** synchronously. A modify-heavy
  test (e.g. SortableJS dragging thousands of items) will be noticeably
  slower than Cuprite per op; a read-heavy test (form fill + a couple
  of asserts) won't be.
- **Polling** (Capybara `default_max_wait_time`) advances a *virtual*
  JS clock — `setTimeout(N)` fires after `N` ms of accumulated wall
  time, not real time. A page that schedules `setTimeout(2000, x)`
  doesn't block for 2 s; it fires once polling has waited that long.

Bottom line: small Hotwire-shaped pages run well below real-browser
wall time. Heavy SPA bundles with full-reload `visit()` patterns won't
beat Cuprite. If you're testing a Turbo Drive app, the click flows in
your tests already get most of the gains for free.

## Known limits

- Without a layout engine: `visible?` and `Node#style` consult the CSS
  cascade (real stylesheet rules via `p_css`) plus the inline `style`
  attribute, but `getBoundingClientRect()` returns zeros and click
  offset coordinates are passed through verbatim. Tests that rely on
  positional click resolution (e.g. Dragula-style drag drops,
  table-cell clicks based on `elementFromPoint`) need a real browser.
- `:hover` / `:focus-within`-gated content is reachable two ways:
  call `element.hover` explicitly (we track the most-recently-hovered
  element and propagate `:hover` up its chain), or rely on the
  candidate-chain fallback (when stateless cascade reports
  `display: none`, we re-evaluate with the candidate itself in the
  `:hover` set). What this *can't* disambiguate is symmetric peers —
  N rows that each have `tr:hover .icon` revealing `.icon`, queried as
  bare `find('.icon')`. Real browsers pick by mouse position; we
  reveal them all and Capybara's `find` raises `Capybara::Ambiguous`.
  The fix is to scope the test (`find('tr', text: 'foo').hover` then
  `find('.icon')`, or `within('tr', text: 'foo') { find('.icon') }`),
  which is also more robust against real-browser flake.
- `fetch` is synchronous-via-Rack — works for HTML/JSON round-trips
  but there is no real network, no streaming, no `Request#body`
  ReadableStream, and no concurrent requests. XHR is not implemented.
- ES modules are loaded via Rack, but `import.meta.url` is set from
  the module specifier — there's no fully-spec-compliant URL parsing
  (no `import.meta.resolve`, no integrity attribute checking).
  Top-level template-literal specifiers (`import \`./${name}.js\``)
  aren't rewritten and will fail to load.
- Multi-window support is URL-tracking only: `target="_blank"` clicks
  open a new window-handle and `current_window`/`switch_to_window`
  work, but each window has its own `Browser` (no cross-window
  `postMessage`, no `window.opener` reference).
- Frames, WebSocket, EventSource, file uploads beyond `Element#drop`,
  screenshots, and scroll / drag pixel coordinates are out of scope —
  use Selenium / Cuprite.

## How it fits together

- `vendor/js/bridge.js` — thin DOM proxy backed by Ruby callbacks via
  `__dom(handle, op, args)`. Every `Element` method delegates straight
  through to `Capybara::Simulated::Browser#dom_op`. The JS side carries
  no DOM state of its own — everything is a thin proxy keyed on integer
  handles. Includes a virtual setTimeout / setInterval / requestAnimationFrame
  clock, MutationObserver dispatch, custom-element registry, modal
  callbacks, location proxy, and HTML5 drag-and-drop synthesis.
- `lib/capybara/simulated/browser.rb` — owns the Nokogiri document, the
  in-process Rack client, and the lazy QuickJS runtime. Handles HTTP
  through `Rack::MockRequest`, fetches `<script src>` inline, runs
  `<script>` tags in document order, and routes form submissions back
  through Rack. Also tracks shadow roots, modal handler stacks, history
  for `go_back` / `go_forward`, and the wall-clock anchor that drives
  the virtual JS clock.
- `lib/capybara/simulated/handle_table.rb` — two-way mapping between
  Nokogiri nodes and integer handles.
- `lib/capybara/simulated/js_runtime.rb` — QuickJS context wrapper +
  the process-wide warm-VM pool. Each `reset_page` swaps in a fresh
  VM (lazily, on next JS access) so every navigation lands on a
  clean JS context. Recycles the VM cleanly on OOM or parser-stack
  overflow.
- `lib/capybara/simulated/{driver,node}.rb` — Capybara `Driver::Base`
  and `Driver::Node` implementations.

## ES modules + importmap

`<script type="module">` and `<script type="importmap">` work the same
way they do in a real browser: bare specifiers resolve through the
importmap, relative paths resolve against the importer's URL, and every
load (including dynamic `import(...)`) routes back through the in-process
Rack app. No bundling step. No Node toolchain. Module sources are
parsed by QuickJS in module mode; nested imports are pre-rewritten to
absolute URLs before the loader callback fires, so the bridge sees one
URL→source resolution per module.

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
importmap-rails apps:

```ruby
# config/importmap.rb (no changes needed for :simulated)
pin '@hotwired/stimulus'
pin '@hotwired/turbo'
```

`window.fetch` is shimmed to route through Rack, so Turbo's frame
fetch + link-action POSTs round-trip the test app.

## Bench

`bench/` ships a small Rack app shaped like a Hotwire-on-Rails screen
(navigation, Stimulus actions, classic POST→302→GET, Turbo Frame fetch
+ swap, Turbo Stream append/replace) and a 21-example RSpec suite that
drives it. `bench/run.rb` runs the suite under each driver in its own
subprocess and prints a comparison table:

```
$ BENCH_RUNS=3 bundle exec ruby bench/run.rb

| driver        | wall time (median) | per-test  | examples | failures |
|---------------|--------------------|-----------|----------|----------|
| simulated     |     0.55s   1.00x |  0.026s   |       21 |        0 |
| selenium      |     8.62s  15.6x  |  0.410s   |       21 |        0 |
```

Numbers above are from a quiet desktop, headless Chrome 148. rack_test
isn't included because the suite exercises Stimulus and Turbo Stream —
those need a JS runtime. The bench is the recommended starting point
when comparing this driver against your own setup; clone, run, read.
