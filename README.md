# capybara-simulated

A lightweight Capybara driver that runs JavaScript in an embedded
[QuickJS](https://github.com/hmsk/quickjs.rb) context against a
[Nokogiri](https://nokogiri.org/)-backed DOM. The driver sits between
`rack-test` (zero JS) and full headless browsers like cuprite/selenium:
in-process tests, no Chrome, inline `<script>` and event handlers run,
the Capybara DSL works, and forms submit through `Rack::MockRequest`.

## Status

Capybara 3.40's shared `Capybara::SpecHelper.spec` suite runs
deterministically green at ~60 seconds (vs Selenium's ~5 minutes
for the same suite). The runner filters the unsupported-capability
tags (`about_scheme`, `css`, `download`, `frames`, `hover`,
`screenshot`, `scroll`, `server`, `spatial`, `windows`) plus a few
classes of test skipped with a documented reason — see
[`spec/capybara_shared_spec.rb`](spec/capybara_shared_spec.rb).
Each cluster falls into one of:

- click-offset / drag-and-drop / `attach_file` via label — need
  `getBoundingClientRect()` / `elementFromPoint()`, i.e. a real
  layout engine.
- `#reload` — read paths don't tick the virtual clock, so a Ruby
  `sleep(N)` between an action and a direct `node.text` doesn't fire
  the action's queued `setTimeout(K)`. Hooking tick into the read
  path works in isolation but stresses neighbouring timing tests
  on the `/with_js` page.

## Install

```ruby
gem 'capybara-simulated', group: :test
```

Then `bundle install`. The gem ships its JS bridge under `vendor/js/`,
so there is no Node toolchain at consume time.

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
by default — the minimum a Hotwire-shaped page needs. If your app's JS
touches `Intl.*`, `Blob` / `File`, or any other QuickJS feature flag,
register the driver with the extras:

```ruby
require 'quickjs'
require 'capybara/simulated'

Capybara.register_driver :simulated do |app|
  Capybara::Simulated::Driver.new(app, features: [Quickjs::POLYFILL_INTL])
end
```

See [`Quickjs.constants`](https://github.com/hmsk/quickjs.rb) for the
full list (`POLYFILL_INTL`, `POLYFILL_FILE`, …). `FEATURE_TIMEOUT`
intentionally isn't honoured — the driver runs JS timers on a virtual
clock so test runs stay deterministic.

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
- `lib/capybara/simulated/js_runtime.rb` — QuickJS context wrapper. Owns
  the bridge, recycles the VM cleanly on OOM or parser-stack overflow.
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

## Performance characteristics

The bench suite above is small and JS-light. Real apps mileage varies a lot
with what the page actually does, so it's worth being explicit about where
the wall-clock time goes:

- **Per-test framework cost** is small. RSpec + Capybara + Rails boot is
  ~3–4 s in cold suites, identical to other drivers.
- **`visit`** dominates `:js` tests. Each external `<script src=...>` is
  fetched through the in-process Rack app, parsed, and run in QuickJS
  *interpreted* (no JIT). Order-of-magnitude per page:

  | page profile                          | typical `visit` |
  |---------------------------------------|-----------------|
  | inline scripts only, ~10 KB JS        |  50–150 ms      |
  | a Hotwire / Stimulus app, ~200 KB JS  | 400 ms – 1 s    |
  | React-on-Rails / Forem, 18+ bundles   | 4–6 s           |

  This scales roughly linearly with bundle bytes (interpreter throughput)
  plus a fixed-cost per microtask / promise hop because each one re-enters
  Ruby for `__deliverMutations` and timer drains.
- **CSS cascade build** (via [`p_css`](https://github.com/ursm/p_css))
  is a one-shot per stylesheet *set*, cached by URL fingerprint and shared
  across pages with the same bundle. Numbers from our two test apps:
  Avo (single 285 KB Tailwind bundle) → ~330 ms; Forem (4 stylesheets,
  688 KB) → ~1.8 s the first time, ~0 ms thereafter. Per-element
  `cascade.resolve()` runs in 100–300 µs and is consulted from
  `visible?` / `Node#style`.
- **DOM ops cross the Ruby↔JS bridge** synchronously. A modify-heavy
  test (e.g. SortableJS dragging thousands of items) will be noticeably
  slower than Cuprite per op; a read-heavy test (form fill + a couple of
  asserts) won't be.
- **Polling** (Capybara `default_max_wait_time`) advances a *virtual*
  JS clock — `setTimeout(N)` fires after `N` ms of accumulated wall time,
  not real time. So a page that schedules `setTimeout(2000, x)` doesn't
  block for 2 s; it fires once polling has waited that long.

In short: we're fast on small / Hotwire-shaped pages and slower than
real Chrome on heavy SPA bundles. The benchmark above is an
intentionally easy case; if your app loads multiple 500 KB+ JS bundles
on every page, expect to be in the same ballpark as Selenium /
Cuprite, not 15× faster.

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
- `fetch` is synchronous-via-Rack — works for HTML/JSON round-trips but
  there is no real network, no streaming, no `Request#body` ReadableStream,
  and no concurrent requests. XHR is not implemented.
- Real navigation only happens on link click, form submit, and JS
  `location` assigns / `history.pushState`.
- ES modules are loaded via Rack, but `import.meta.url` is set from the
  module specifier — there's no fully-spec-compliant URL parsing (no
  `import.meta.resolve`, no integrity attribute checking). Top-level
  template-literal specifiers (`import \`./${name}.js\``) aren't
  rewritten and will fail to load.
- Frames, multi-window, WebSocket, EventSource, file uploads beyond
  `Element#drop`, screenshots, CSS computed-style filters, and scroll /
  drag pixel coordinates are out of scope — use Selenium / Cuprite.
