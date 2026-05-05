require_relative 'spec_helper'

# Hotwire smoke: Stimulus + Turbo loaded as UMD bundles via classic
# `<script src="...">` tags. We don't support `<script type="module">`
# / importmap-style ES modules, so apps using importmap-rails should pin
# to the UMD distributions of these libraries.
#
# Bundles live under spec/fixtures/hotwire/ — fetch them with
# `bin/rake fixtures:hotwire` (or just curl from unpkg). They're
# .gitignored.
RSpec.describe 'Hotwire (Stimulus + Turbo) via UMD' do
  STIMULUS_UMD = File.expand_path('fixtures/hotwire/stimulus.umd.js', __dir__)
  TURBO_UMD    = File.expand_path('fixtures/hotwire/turbo.umd.js',    __dir__)

  before(:all) do
    [STIMULUS_UMD, TURBO_UMD].each do |path|
      next if File.exist?(path)
      skip "missing #{path} — run `bin/rake fixtures:hotwire` to download"
    end
  end

  let(:stimulus_src) { File.read(STIMULUS_UMD) }
  let(:turbo_src)    { File.read(TURBO_UMD) }

  let(:hello_app) {
    src = stimulus_src
    lambda do |env|
      case env['PATH_INFO']
      when '/'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head>
            <script src="/js/stimulus.umd.js"></script>
          </head><body>
            <div data-controller="hello">
              <span data-hello-target="output"></span>
              <button data-action="click->hello#greet" id="go">Go</button>
            </div>
            <script>
              const { Application, Controller } = window.Stimulus;
              const app = Application.start();
              app.register('hello', class extends Controller {
                static targets = ['output'];
                greet() { this.outputTarget.textContent = 'hello from stimulus'; }
              });
              window.__app = app;
            </script>
          </body></html>
        HTML
      when '/js/stimulus.umd.js'
        [200, {'content-type' => 'application/javascript'}, [src]]
      else
        [404, {}, ['nope']]
      end
    end
  }

  let(:session) { Capybara::Session.new(:simulated, hello_app) }

  it 'starts the Stimulus application and connects controllers' do
    session.visit '/'
    started = session.evaluate_script(
      '!!(window.__app && window.__app.router && window.__app.controllers)'
    )
    expect(started).to be true
  end

  it 'invokes a controller action wired through data-action' do
    session.visit '/'
    session.find('#go').click
    expect(session).to have_css('span[data-hello-target="output"]', text: 'hello from stimulus')
  end

  it 'connects controllers attached to the DOM after Application.start' do
    session.visit '/'
    session.execute_script(<<~JS)
      const div = document.createElement('div');
      div.setAttribute('data-controller', 'hello');
      div.id = 'late';
      div.innerHTML = '<span data-hello-target="output"></span>'
        + '<button data-action="click->hello#greet" id="late-go"></button>';
      document.body.appendChild(div);
    JS
    session.find('#late-go').click
    expect(session).to have_css('#late span[data-hello-target="output"]', text: 'hello from stimulus')
  end

  describe 'Turbo frame fetch + swap' do
    let(:frame_app) {
      src = turbo_src
      lambda do |env|
        case env['PATH_INFO']
        when '/'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><head>
              <script src="/js/turbo.umd.js"></script>
            </head><body>
              <turbo-frame id="msg">
                <a href="/frame" id="load-frame">load</a>
              </turbo-frame>
            </body></html>
          HTML
        when '/frame'
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><html><body>
              <turbo-frame id="msg"><p id="loaded">frame body</p></turbo-frame>
            </body></html>
          HTML
        when '/js/turbo.umd.js'
          [200, {'content-type' => 'application/javascript'}, [src]]
        else
          [404, {}, ['nope']]
        end
      end
    }

    it 'replaces a turbo-frame body via fetch on link click' do
      session = Capybara::Session.new(:simulated, frame_app)
      session.visit '/'
      session.find('#load-frame').click
      expect(session).to have_css('#loaded', text: 'frame body')
    end
  end
end
