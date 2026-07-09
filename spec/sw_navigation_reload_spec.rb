# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/js_engine'
require 'rack'

# A reload navigation of a controlled iframe (location.reload() / history.go(0)) routes through
# the controlling service worker's fetch event with `request.isReloadNavigation === true` — the
# initial load is not a reload. (The WPT surface lives in service-workers/service-worker/
# fetch-event + cache-storage/cache-keys-attributes; this pins the mechanism directly.)
RSpec.describe 'Service Worker reload-navigation interception' do
  let(:worker) {
    <<~JS
      self.addEventListener('fetch', e => {
        if (e.request.mode === 'navigate') {
          e.respondWith(new Response('reload=' + e.request.isReloadNavigation, {headers: {'content-type': 'text/html'}}));
        }
      });
    JS
  }
  let(:app) {
    sw = worker
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [sw]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>from-network</body></html>']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { skip 'SW navigation interception needs per-frame realms (V8 engine)' unless CsimEngine.v8? }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  # Register the SW at /scope/, wait for activation, build a controlled iframe, and return the
  # session with the iframe (id 'f') loaded (its body reflects the SW's isReloadNavigation echo).
  def controlled_iframe
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__ready = false;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.id = 'f'; f.src = '/scope/page.html';
        document.body.appendChild(f);
        globalThis.__ready = true;
      });
    JS
    20.times { break if session.evaluate_script("globalThis.__ready === true && !!(document.getElementById('f') && document.getElementById('f').contentDocument && document.getElementById('f').contentDocument.body.textContent)"); sleep 0.02 }
    session
  end

  def frame_body(session)
    session.evaluate_script("document.getElementById('f').contentDocument.body.textContent")
  end

  it 'the initial load is not a reload navigation' do
    session = controlled_iframe
    expect(frame_body(session)).to eq('reload=false')
  end

  it 'location.reload() is a reload navigation and fires the frame load event' do
    session = controlled_iframe
    session.execute_script("globalThis.__loads = 0; document.getElementById('f').addEventListener('load', () => { globalThis.__loads++; }); document.getElementById('f').contentWindow.location.reload();")
    8.times { break if frame_body(session) == 'reload=true'; sleep 0.03 }
    expect(frame_body(session)).to eq('reload=true')
    expect(session.evaluate_script('globalThis.__loads')).to be >= 1
  end

  it 'history.go(0) is a reload navigation (delegates to location.reload)' do
    session = controlled_iframe
    session.execute_script("document.getElementById('f').contentWindow.history.go(0);")
    8.times { break if frame_body(session) == 'reload=true'; sleep 0.03 }
    expect(frame_body(session)).to eq('reload=true')
  end
end
