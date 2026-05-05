require_relative 'spec_helper'

# Standard Rails importmap-rails layout: `<script type="importmap">`
# pins specifiers to URLs, `<script type="module">` `import`s from
# those specifiers. The driver routes module loads through
# `Browser#load_module` (Rack-backed) via quickjs.rb's
# `vm.module_loader` callback — same surface the production
# browser would hit.
RSpec.describe 'ESM via importmap' do
  STIMULUS_ESM = File.expand_path('fixtures/hotwire/stimulus.js',  __dir__)
  TURBO_ESM    = File.expand_path('fixtures/hotwire/turbo.esm.js', __dir__)

  before(:all) do
    [STIMULUS_ESM, TURBO_ESM].each do |path|
      next if File.exist?(path)
      skip "missing #{path} — run `bin/rake fixtures:hotwire` to download"
    end
  end

  let(:stimulus_src) { File.read(STIMULUS_ESM) }
  let(:turbo_src)    { File.read(TURBO_ESM) }

  let(:hello_app) {
    src = stimulus_src
    page = ->(extra) {
      <<~HTML
        <!doctype html><html><head>
          <script type="importmap">
          {
            "imports": {
              "@hotwired/stimulus":            "/js/stimulus.js",
              "controllers/hello_controller":  "/js/hello_controller.js"
            }
          }
          </script>
        </head><body>
          <div data-controller="hello">
            <span data-hello-target="output"></span>
            <button data-action="click->hello#greet" id="go">Go</button>
          </div>
          #{extra}
          <script type="module">
            import { Application } from "@hotwired/stimulus";
            import HelloController from "controllers/hello_controller";
            const app = Application.start();
            app.register("hello", HelloController);
            window.__app = app;
          </script>
        </body></html>
      HTML
    }
    lambda do |env|
      case env['PATH_INFO']
      when '/'      then [200, {'content-type' => 'text/html'}, [page.call('<a href="/page2" id="nav">page2</a>')]]
      when '/page2' then [200, {'content-type' => 'text/html'}, [page.call('<p>page2</p>')]]
      when '/js/stimulus.js'
        [200, {'content-type' => 'application/javascript'}, [src]]
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

  let(:session) { Capybara::Session.new(:simulated, hello_app) }

  it 'starts Stimulus via ESM importmap and bare specifiers' do
    session.visit '/'
    started = session.evaluate_script(
      '!!(window.__app && window.__app.router && window.__app.controllers)'
    )
    expect(started).to be true
  end

  it 'wires a Stimulus action through ESM-pinned controller module' do
    session.visit '/'
    session.find('#go').click
    expect(session).to have_css('span[data-hello-target="output"]', text: 'hello from stimulus')
  end

  it 'fires Stimulus actions on a freshly-navigated page (cached ESM modules)' do
    session.visit '/'
    session.find('#nav').click
    expect(session).to have_current_path('/page2')
    session.find('#go').click
    expect(session).to have_css('span[data-hello-target="output"]', text: 'hello from stimulus')
  end

  describe 'Turbo via ESM importmap' do
    let(:frame_app) {
      src = turbo_src
      lambda do |env|
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
            <!doctype html><html><body>
              <turbo-frame id="msg"><p id="loaded">frame body</p></turbo-frame>
            </body></html>
          HTML
        when '/js/turbo.js'
          [200, {'content-type' => 'application/javascript'}, [src]]
        else
          [404, {}, ['nope']]
        end
      end
    }

    it 'fetches and swaps a turbo-frame on link click' do
      session = Capybara::Session.new(:simulated, frame_app)
      session.visit '/'
      session.find('#load-frame').click
      expect(session).to have_css('#loaded', text: 'frame body')
    end
  end

  describe 'relative imports' do
    let(:rel_app) {
      lambda do |env|
        case env['PATH_INFO']
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><head></head><body>
              <p id="out"></p>
              <script type="module">
                import { greet } from "/js/lib/hello.js";
                document.getElementById('out').textContent = greet('world');
              </script>
            </body></html>
          HTML
        when '/js/lib/hello.js'
          [200, {'content-type' => 'application/javascript'}, [<<~JS]]
            import { upper } from "./case.js";
            export function greet(name) { return "Hi, " + upper(name); }
          JS
        when '/js/lib/case.js'
          [200, {'content-type' => 'application/javascript'}, [<<~JS]]
            export function upper(s) { return String(s).toUpperCase(); }
          JS
        else
          [404, {}, ['nope']]
        end
      end
    }

    it 'resolves nested relative imports through the loader' do
      session = Capybara::Session.new(:simulated, rel_app)
      session.visit '/'
      expect(session.find('#out').text).to eq('Hi, WORLD')
    end
  end
end
