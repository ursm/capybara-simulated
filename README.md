# capybara-simulated

A lightweight Capybara driver that runs JavaScript in a long-lived
[mini_racer](https://github.com/rubyjs/mini_racer) V8 context against a
[happy-dom](https://github.com/capricorn86/happy-dom) DOM. XPath queries
are powered by [fontoxpath](https://github.com/FontoXML/fontoxpath).

The goal is the middle ground between `rack-test` (zero JS) and full
headless browsers like cuprite/selenium: in-process tests, no Chrome,
inline `<script>` and event handlers run, the Capybara DSL works, and
forms submit through `Rack::MockRequest`.

## Status

PoC. Against Capybara 3.40's shared `Capybara::SpecHelper.spec` suite the
driver passes **1337 / 1357 examples (98.5%)** with the unsupported-
capability tags `about_scheme`, `css`, `download`, `frames`, `hover`,
`screenshot`, `scroll`, `server`, `spatial`, `windows` filtered out.
Tags that started skipped but now pass: `active_element`, `modals`
(alert/confirm/prompt incl. nested + page-change + async),
`html_validation`, `send_keys`, `shadow_dom`. The remaining 20
failures all need capabilities the driver intentionally does not
implement:

- 19 `#drag_to` tests — Dragula / SortableJS / jsTree resolve drop
  targets through `elementFromPoint(clientX, clientY)`, which needs a
  real layout engine with stacking-context awareness.
- 1 `#click should not retry clicking when wait is disabled` — depends
  on the same `elementFromPoint`-based obscured-element detection.

`evaluate_async_script` is supported by polling the Ruby↔V8 bridge while
draining the virtual clock until the user callback fires (or
`Capybara.default_max_wait_time` elapses). Click offsets and `Element#drop`
work without a real layout engine: click x/y are resolved into clientX/Y
by walking computed `top`/`left`/`width`/`height` (px only, ancestor-sum)
on the way out of the runtime.

### Turbo + Stimulus (Rails)

The driver targets Rails apps using importmap-rails + Turbo + Stimulus
out of the box:

- `<script type="importmap">` is parsed; `<script type="module">` and
  every reachable `import` are pre-fetched through the Rack app and
  bundled on the fly via `node vendor/js/bundle-modules.mjs` (a small
  esbuild driver). The resulting IIFE is evaluated in the same isolate
  as inline scripts and shares the same happy-dom Window.
- `fetch` is replaced with a Rack-routed implementation: cookies follow
  the jar, `X-CSRF-Token` propagates, redirects are followed up to 20
  hops, and `Response`/`Headers`/`Request`/`AbortController` come from
  happy-dom. WebSocket / EventSource / Action Cable broadcasts are out
  of scope — use Selenium for those flows.
- Custom-element upgrade is patched at `customElements.define` to
  rebuild the document's id-element index — happy-dom 20's auto-upgrade
  leaves the original (un-upgraded) element in the index, so
  `getElementById('records')` after a Turbo Stream `<turbo-frame>` swap
  would otherwise return a detached ghost.
- Click on `<button type="submit">` lets happy-dom auto-dispatch the
  `submit` event with the proper `submitter` field; we capture whether
  the event was preventDefaulted and skip our own redundant submit
  dispatch. Without this, Turbo's `FormSubmitObserver` saw a second
  submitter-less event and intercepted forms whose submitter had
  `data-turbo="false"`.
- Page-level globals (`addEventListener`, `MutationObserver`,
  `requestAnimationFrame`, `CustomEvent`, `getComputedStyle`,
  `IntersectionObserver` stub, etc.) are mirrored from the active
  Window onto `globalThis` so module bundles running at the top level
  find them without going through `window.*`.
- happy-dom's `MutationObserverListener` keeps its dispatch callback in
  a `WeakRef`, with no other strong reference. V8 collects the arrow
  before the next mutation fires, so `target[mutationListeners]` still
  carries the listener but `callback.deref()` returns undefined and
  every record (and every subtree-propagation hop on `appendChild`) is
  silently dropped — Stimulus loses sight of buttons added inside a
  swapped `<turbo-frame>`. We patch `MutationObserver.prototype.observe`
  per Window to swap each WeakRef out for a strong-reference shim with
  the same `.deref()` shape, so listeners survive the next GC.

WebSocket, frames and multi-window remain explicitly out of scope — they
need a real browser (Selenium / Cuprite) or a separate transport that
this driver does not provide.

The V8 isolate is created once per `Capybara::Simulated::Browser` instance
and reused across all visits and resets — only the happy-dom `Window` is
torn down between specs. This keeps `reset!` cheap.

## Build

```
npm install
npm run build         # produces vendor/js/csim.bundle.js (~3.3MB)
bundle install
bundle exec rspec
```

## Use

```ruby
require 'capybara/simulated'

Capybara.javascript_driver = :simulated
```

## How it fits together

- `vendor/js/prelude.js` — minimal Web Platform polyfills (TextEncoder,
  atob/btoa, crypto.getRandomValues, performance, timers, process).
- `vendor/js/csim.bundle.js` — bundled happy-dom + whatwg-url +
  fontoxpath. Built via `build.mjs` with esbuild, with shims for the
  Node built-ins happy-dom imports (`url`, `buffer`, `vm`, `path`, etc.).
- `vendor/js/runtime.js` — driver glue exposed on `globalThis.__csim`.
  Manages the active happy-dom `Window`, an integer→DOM-node handle
  table, modal capture, form serialization, click/submit dispatch, and
  XPath via fontoxpath with a custom DOM facade.
- `lib/capybara/simulated/browser.rb` — owns the `MiniRacer::Context`,
  drives HTTP via `Rack::MockRequest`, fetches `<script src>` inline,
  and routes form submissions back through Rack.
- `lib/capybara/simulated/{driver,node}.rb` — Capybara `Driver::Base` and
  `Driver::Node` implementations.

## Known limits

- happy-dom is not a layout engine — `visible?` is heuristic
  (`display:none`, `visibility:hidden`, `hidden` attribute, head/script).
- No fetch/XHR. `<script src>` is inlined via `Rack::MockRequest`. Real
  navigation only happens on link click and form submit.
- `evaluate_async_script`, frames, multi-window, file uploads, screenshots,
  CSS computed-style filters, scroll/drag pixel coordinates are out of
  scope.
