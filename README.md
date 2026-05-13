# capybara-simulated

A lightweight Capybara driver that runs JavaScript against a V8-resident
DOM, in-process, with no Chrome. Forms submit through `Rack::MockRequest`,
inline `<script>` and event handlers run, MutationObserver / custom
elements / `<template>` / Shadow DOM / Trix / Stimulus / Turbo all work,
and the Capybara DSL is unchanged.

The DOM lives entirely inside [V8 via
mini_racer](https://github.com/rubyjs/mini_racer) — there is no Nokogiri
tree on the Ruby side. Capybara finds resolve through wgxpath /
CSS-selector code running in the same V8 context as the page's JS, so
`find` / `has_css?` / `within` see exactly the tree the app sees.

## Status

| suite | result | wall time |
|---|---|---:|
| Capybara 3.40 shared spec | 1384 / 0 fail / 34 pending | 1m 10s |
| Redmine system tests (115 tests after the 7 SCM-only skips) | 115 / 0 fail | ~55s |
| vs Selenium (Chrome 147) on Redmine | **1.53× faster** | (81.6s) |

The 34 shared-spec pending tests all need a real layout engine
(`elementFromPoint`, real `getBoundingClientRect`, viewport-clip
visibility, `display: contents` table edge cases) — same set Selenium
escapes via screenshots and we don't try to simulate.

## Install

```ruby
gem 'capybara-simulated', group: :test
gem 'mini_racer',         group: :test
```

`bundle install`. The gem ships its JS bridge under `vendor/js/`, so
there's no Node toolchain at consume time.

## Use

`require 'capybara/simulated'` registers the `:simulated_v3` driver.

### RSpec

```ruby
# spec/spec_helper.rb (or spec/rails_helper.rb)
require 'capybara/rspec'
require 'capybara/simulated'

Capybara.javascript_driver = :simulated_v3
# Optional: use :simulated_v3 for non-JS specs too.
# Capybara.default_driver = :simulated_v3
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
  before { driven_by :simulated_v3 }
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
  driven_by :simulated_v3
end
```

### Plain Capybara DSL (no framework)

```ruby
require 'capybara/dsl'
require 'capybara/simulated'

Capybara.app = MyRackApp
Capybara.default_driver = :simulated_v3

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
run-to-run-variance equivalent (~0.4s on a 122-test Redmine suite,
i.e. zero) because the expensive part — DOM serialization — only
fires on action error.

### Modes (`CSIM_TRACE=…`)

| value | recording | DOM snapshot |
|---|---|---|
| (unset) / `on-failure` | yes (default) | per step on action error only |
| `full` | yes | after every action — v2-equivalent, debug-heavy |
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

The driver builds a V8 base snapshot once per process (bridge.js +
wgxpath, ~330 KB of source) and checks Contexts out of a small
process-wide pool of pre-warmed clones, so each navigation lands on a
fresh JS context instantly.

**Wall time is sensitive to whether the app uses Turbo Drive**,
because navigation simulates real-browser semantics:

| navigation source | what happens |
|---|---|
| `visit(...)`, `refresh`, programmatic `location.assign` | full reload — fresh V8 Context, scripts re-evaluated |
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
referenced page-specific DOM. Per-visit library re-eval costs ~5 ms
per library; the lost snapshot speedup turned out to be inside
run-to-run measurement noise.

### Other factors

- **`<script src>` parsing** dominates `visit` on JS-heavy pages.
  Each external script is fetched through the in-process Rack app,
  compiled, and run in V8 with bytecode cache hits from the base
  snapshot warmup. Order of magnitude per cold visit:

  | page profile | typical cold `visit` |
  |---|---|
  | inline scripts only, ~10 KB JS | 30–80 ms |
  | a Hotwire / Stimulus app, ~200 KB JS | 200–500 ms |
  | React-on-Rails / Forem, 18+ bundles | 2–4 s |

- **CSS cascade resolution**: rules are parsed once on first encounter
  per stylesheet set; subsequent finds on the same page hit the
  cached `__layoutRules` / `__hideRules` arrays in JS-side memory.
- **DOM ops stay inside V8** — find / has_? / event dispatch never
  cross the Ruby ↔ JS boundary for the actual tree walk; only the
  resulting handle ids do. Modify-heavy tests (SortableJS dragging
  thousands of items) run at V8 speed, not at mini_racer-IPC speed.
- **Polling** (Capybara `default_max_wait_time`) advances a *virtual*
  JS clock — `setTimeout(N)` fires after `N` ms of accumulated wall
  time, not real time. A page that schedules `setTimeout(2000, x)`
  doesn't block for 2 s; it fires once polling has waited that long.

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
- **ES modules** are loaded via Rack with bare-specifier resolution
  through importmaps and relative-path resolution against the
  importer URL, but `import.meta.url` is set from the module
  specifier (not a fully-spec URL), and template-literal specifiers
  (`` import `./${name}.js` ``) aren't rewritten.
- **Multi-window** is URL-tracking only — `target="_blank"` clicks
  open a window-handle and `current_window` / `switch_to_window`
  work, but each window has its own `Browser` (no cross-window
  `postMessage`, no `window.opener` reference).
- **Frames, WebSocket, EventSource, screenshots, and drag pixel
  coordinates** are out of scope — use Selenium / Cuprite.

## Architecture

- `vendor/js/v3_bridge.js` — the entire DOM lives here. `Document` /
  `Element` / `Text` / `DocumentFragment` / `ShadowRoot` classes;
  CSS selector tokeniser + matcher; event dispatch (capture / target
  / bubble phases with `dispatchEvent(target, event)`); virtual
  `setTimeout` / `setInterval` / `requestAnimationFrame` clock;
  MutationObserver; custom-element registry; `Range` /
  `getSelection`; cascade resolver for `display` / `visibility` /
  `text-transform` / layout primitives. wgxpath sits on top for
  XPath. Approx 7000 lines.
- `lib/capybara/simulated/v3_browser.rb` — Rack client, history
  stack, modal handler queue, virtual-clock anchor, trace recorder.
  Owns the V8 runtime via `V3Runtime`. The hot operations
  (`find_css` / `find_xpath` / DOM ops / event dispatch) are
  single-`Context#call` round-trips returning handle id arrays;
  per-result iteration stays Ruby-side.
- `lib/capybara/simulated/v3_runtime.rb` — V8 base-snapshot build +
  per-Context pool. The base snapshot caches bridge.js + wgxpath
  bytecode so each Context spawn is sub-millisecond. Pool refills
  in a background thread.
- `lib/capybara/simulated/v3_driver.rb` — Capybara `Driver::Base`
  surface (visit / find / execute_script / window handling / modal /
  tracing API).
- `lib/capybara/simulated/v3_node.rb` — `Driver::Node` over a
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

## Legacy driver

The original Nokogiri-backed driver is still registered as
`:simulated` (vs the V8-resident `:simulated_v3`). It's slower
(~1.79× on Redmine system tests) and missing a few of the newer
features (Shadow DOM stub, `text-transform` on visible text, the
trace surface above). New projects should pick `:simulated_v3`.
