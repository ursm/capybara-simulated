# capybara-simulated

A lightweight Capybara driver that runs JavaScript in a long-lived
[QuickJS](https://github.com/hmsk/quickjs.rb) context against a
[Nokogiri](https://nokogiri.org/)-backed DOM. The driver sits between
`rack-test` (zero JS) and full headless browsers like cuprite/selenium:
in-process tests, no Chrome, inline `<script>` and event handlers run,
the Capybara DSL works, and forms submit through `Rack::MockRequest`.

## Status

Against Capybara 3.40's shared `Capybara::SpecHelper.spec` suite the
driver passes 1330+ / 1357 examples in ~70 seconds (vs Selenium's
~5 minutes for the same suite), with the unsupported-capability tags
`about_scheme`, `css`, `download`, `frames`, `hover`, `screenshot`,
`scroll`, `server`, `spatial`, `windows` filtered out. The remaining
failures cluster into:

- ~21 click-offset / table-row click tests — these resolve clientX/Y
  against `getBoundingClientRect()`, which needs a real layout engine.
- A handful of timing-sensitive assertions that occasionally flake when
  QuickJS recycles the VM mid-test under sustained allocation pressure.

The 22 pending tests need capabilities the driver intentionally does not
implement:

- 19 `#drag_to` tests — Dragula / SortableJS / jsTree resolve drop
  targets through `elementFromPoint(clientX, clientY)`, which needs a
  layout engine with stacking-context awareness.
- 1 `#click should not retry clicking when wait is disabled` — depends
  on the same `elementFromPoint`-based obscured-element detection.
- 2 unrelated upstream-pending specs.

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

## Known limits

- Without a layout engine: `visible?` is heuristic (`display:none`,
  `visibility:hidden`, `hidden` attribute, `<details>` open state, etc.),
  `getBoundingClientRect()` returns zeros, and click offset coordinates
  are passed through verbatim. Tests that rely on positional click
  resolution (e.g. Dragula-style drag drops, table-cell clicks based on
  `elementFromPoint`) need a real browser.
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
