require_relative 'spec_helper'
require_relative 'support/session_teardown'

# Standard Rails importmap-rails layout: `<script type="importmap">`
# pins specifiers to URLs, `<script type="module">` `import`s from
# those specifiers. The bridge routes module loads through Rack via
# the runtime's native ESM loader, the same surface a real browser
# would hit.
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

  let(:session) { simulated_session(hello_app) }

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
      session = simulated_session(frame_app)
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
      session = simulated_session(rel_app)
      session.visit '/'
      expect(session.find('#out').text).to eq('Hi, WORLD')
    end
  end
end

# HTML's import maps themselves (import_map.rs), apart from any library.
RSpec.describe 'import maps' do
  # HTML's import maps: a prefix key (`lib/`) maps what follows it, a scope's map covers the modules under its URL
  # before the top-level one, and a second map's entry for a key the first has is ignored (the first wins).
  it 'resolves through prefix keys and scopes, the first map winning a key' do
    page = <<~HTML
      <!doctype html><html><head>
        <script type="importmap">{"imports": {"a": "/js/a1.js", "lib/": "/js/lib/"}, "scopes": {"/js/scoped/": {"a": "/js/a2.js"}}}</script>
        <script type="importmap">{"imports": {"a": "/js/a3.js", "b": "/js/b.js"}}</script>
      </head><body><div id="out"></div>
        <script type="module">
          import a from "a";
          import b from "b";
          import x from "lib/x.js";
          import s from "/js/scoped/s.js";
          document.getElementById('out').textContent = [a, b, x, s].join(' ');
        </script>
      </body></html>
    HTML
    modules = {
      '/js/a1.js' => 'export default "a1";', '/js/a2.js' => 'export default "a2";', '/js/a3.js' => 'export default "a3";',
      '/js/b.js' => 'export default "b";', '/js/lib/x.js' => 'export default "x";',
      '/js/scoped/s.js' => 'import a from "a"; export default "s:" + a;'
    }
    app = lambda {|env|
      body = modules[env['PATH_INFO']]
      body ? [200, {'content-type' => 'text/javascript'}, [body]] : [200, {'content-type' => 'text/html'}, [page]]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.find('#out').text).to eq('a1 b x s:a2')
  end

  # Each document's import map is its own: a frame's neither replaces its parent's nor clears it, for a static import or
  # a dynamic `import()` alike.
  it "keeps a frame's import map apart from its parent's" do
    frame = <<~HTML
      <!doctype html><script type="importmap">{"imports": {"a": "/js/a2.js"}}</script>
      <div id="f"></div><script type="module">import a from "a"; document.getElementById('f').textContent = a;</script>
    HTML
    page = <<~HTML
      <!doctype html><html><head><script type="importmap">{"imports": {"a": "/js/a1.js"}}</script></head>
      <body><div id="out"></div><iframe src="/frame"></iframe>
        <script type="module">
          const frame = document.querySelector('iframe');
          frame.onload = () => setTimeout(async () => {
            const a = (await import("a")).default;
            document.getElementById('out').textContent = a + ' ' + frame.contentDocument.getElementById('f').textContent;
          }, 50);
        </script>
      </body></html>
    HTML
    modules = {'/js/a1.js' => 'export default "a1";', '/js/a2.js' => 'export default "a2";'}
    app = lambda {|env|
      next [200, {'content-type' => 'text/html'}, [frame]] if env['PATH_INFO'] == '/frame'
      body = modules[env['PATH_INFO']]
      body ? [200, {'content-type' => 'text/javascript'}, [body]] : [200, {'content-type' => 'text/html'}, [page]]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.find('#out', text: /a/).text).to eq('a1 a2')
  end

  # An inline script's `import()` resolves against the document base URL of the realm it runs in: a frame's document's,
  # not the page's, and a `<base href>`'s (HTML "resolve a module specifier": the referring script's base URL, an inline
  # one's its document's).
  it "resolves an inline script's import() against its document's base URL" do
    app = lambda {|env|
      body = case env['PATH_INFO']
             when %r{d\.js\z} then next [200, {'content-type' => 'text/javascript'}, ["export default '#{env['PATH_INFO']}'"]]
             when '/dir/g' then '<script>import("./d.js").then((m) => { window.got = m.default; })</script>'
             when '/b' then '<base href="/bdir/"><script>import("./d.js").then((m) => { window.got = m.default; })</script>'
             else '<iframe src="/dir/g"></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_async_script('const done = arguments[0]; const w = () => frames[0].got ? done(frames[0].got) : setTimeout(w, 10); w();')).to eq('/dir/d.js')
    s.visit '/b'
    expect(s.evaluate_async_script('const done = arguments[0]; const w = () => window.got ? done(window.got) : setTimeout(w, 10); w();')).to eq('/bdir/d.js')
  end
end
