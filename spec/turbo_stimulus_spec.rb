require_relative 'spec_helper'

# Smoke-test that a Rails-style importmap setup running real Turbo +
# Stimulus drives the page in our isolate. The module sources below are
# the exact ESM bundles published on npm — same as `bin/importmap pin`
# would resolve to.
RSpec.describe 'Turbo + Stimulus via importmap' do
  STIMULUS_DIST = File.expand_path('../node_modules/@hotwired/stimulus/dist/stimulus.js', __dir__)
  TURBO_DIST    = File.expand_path('../node_modules/@hotwired/turbo/dist/turbo.es2017-esm.js', __dir__)

  let(:app) {
    stimulus_src = File.read(STIMULUS_DIST)
    turbo_src    = File.read(TURBO_DIST)
    lambda do |env|
      case env['PATH_INFO']
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head>
            <script type="importmap">
            {
              "imports": {
                "@hotwired/stimulus": "/js/stimulus.js",
                "@hotwired/turbo":    "/js/turbo.js",
                "controllers/hello_controller": "/js/hello_controller.js"
              }
            }
            </script>
          </head><body>
            <div data-controller="hello">
              <span data-hello-target="output"></span>
              <button data-action="click->hello#greet" id="go">Go</button>
            </div>
            <script type="module">
              import "@hotwired/turbo";
              import { Application } from "@hotwired/stimulus";
              import HelloController from "controllers/hello_controller";
              const app = Application.start();
              app.register("hello", HelloController);
              window.__app = app;
            </script>
          </body></html>
        HTML
      when '/js/stimulus.js'
        [200, {'content-type' => 'application/javascript'}, [stimulus_src]]
      when '/js/turbo.js'
        [200, {'content-type' => 'application/javascript'}, [turbo_src]]
      when '/js/hello_controller.js'
        [200, {'content-type' => 'application/javascript'}, [<<~JS]]
          import { Controller } from "@hotwired/stimulus"
          export default class extends Controller {
            static targets = ["output"]
            greet() { this.outputTarget.textContent = "hello from stimulus" }
          }
        JS
      else
        [404, {}, ['nope']]
      end
    end
  }

  let(:driver) { Capybara::Simulated::Driver.new(app) }

  it 'starts the Stimulus application and connects controllers' do
    driver.visit('/')
    started = driver.evaluate_script('!!(window.__app && window.__app.router && window.__app.controllers)')
    expect(started).to be true
  end

  it 'invokes a controller action wired through data-action' do
    driver.visit('/')
    driver.find_css('#go').first.click
    expect(driver.find_css('span[data-hello-target="output"]').first.all_text).to eq('hello from stimulus')
  end

  it 'replaces a turbo-frame body via fetch on link click' do
    frame_app = ->(env) {
      case env['PATH_INFO']
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head>
            <script type="importmap">
              { "imports": {"@hotwired/turbo": "/js/turbo.js"} }
            </script>
          </head><body>
            <turbo-frame id="msg">
              <a href="/frame" id="load-frame">load</a>
            </turbo-frame>
            <script type="module">import "@hotwired/turbo";</script>
          </body></html>
        HTML
      when '/frame'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <turbo-frame id="msg"><p id="loaded">frame body</p></turbo-frame>
        HTML
      when '/js/turbo.js'
        [200, {'content-type' => 'application/javascript'}, [File.read(TURBO_DIST)]]
      else
        [404, {}, ['nope']]
      end
    }
    d = Capybara::Simulated::Driver.new(frame_app)
    d.visit('/')
    d.find_css('#load-frame').first.click
    # Turbo navigates the frame asynchronously via fetch; give it a beat.
    Capybara.using_wait_time(1) do
      Timeout.timeout(2) { sleep 0.05 until d.find_css('#loaded').any? }
    end
    expect(d.find_css('#loaded').first.all_text).to eq('frame body')
  end

  it 'connects controllers attached to the DOM after Application.start' do
    driver.visit('/')
    # Inject a *new* hello-controller subtree post-start. Stimulus relies on
    # MutationObserver firing for `data-controller` to wire it up.
    driver.execute_script(<<~JS)
      const div = document.createElement('div');
      div.setAttribute('data-controller', 'hello');
      div.id = 'late';
      div.innerHTML = '<span data-hello-target="output"></span><button data-action="click->hello#greet" id="late-go"></button>';
      document.body.appendChild(div);
    JS
    driver.find_css('#late-go').first.click
    expect(driver.find_css('#late span').first.all_text).to eq('hello from stimulus')
  end

  it 'survives a GC of the WeakRef-only callback that happy-dom uses for mutation listeners' do
    driver.visit('/')
    # Simulate a real GC pass: replace every un-pinned WeakRef with a dead
    # one. With installMutationObserverPin in place every listener has
    # already been swapped to a strong-ref shim, so this is a no-op and
    # the click below still wakes Stimulus. Without the pin, the
    # simulation kills every listener and Stimulus never sees the new
    # subtree — the click then asserts.
    driver.execute_script(<<~JS)
      const sym = Object.getOwnPropertySymbols(document)
        .find((s) => s.description === 'mutationListeners');
      const collect = (node, acc) => {
        if (!node) return acc;
        const ls = sym ? node[sym] : null;
        if (Array.isArray(ls)) for (const l of ls) acc.add(l);
        for (const c of node.childNodes || []) collect(c, acc);
        return acc;
      };
      for (const l of collect(document, new Set())) {
        if (l && l.callback && typeof l.callback.deref === 'function' && !l.callback.__csim_strong) {
          l.callback = {deref() {}};
        }
      }
    JS

    driver.execute_script(<<~JS)
      const div = document.createElement('div');
      div.setAttribute('data-controller', 'hello');
      div.id = 'gc-late';
      div.innerHTML = '<span data-hello-target="output"></span><button data-action="click->hello#greet" id="gc-late-go"></button>';
      document.body.appendChild(div);
    JS
    driver.find_css('#gc-late-go').first.click
    expect(driver.find_css('#gc-late span').first.all_text).to eq('hello from stimulus')
  end
end
