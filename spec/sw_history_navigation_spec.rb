# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/js_engine'
require 'rack'
require_relative 'support/session_teardown'

# A cross-document history traversal (history.go(-1)/back()) of a controlled iframe routes
# through the controlling service worker's fetch event with `request.isHistoryNavigation ===
# true`; the initial load and a fresh src-navigation are not history navigations. Requires two
# foundational pieces (inc-5c): a `frame.src=` re-navigation records a frame session-history
# entry, and the Ruby-side traversal refetch consults the SW. (The WPT surface —
# cache-storage/cache-keys-attributes — needs the harness's frame model; this pins the
# mechanism directly.)
RSpec.describe 'Service Worker history-navigation interception' do
  let(:worker) {
    <<~JS
      self.addEventListener('fetch', e => {
        if (e.request.mode === 'navigate') {
          e.respondWith(new Response('hist=' + e.request.isHistoryNavigation, {headers: {'content-type': 'text/html'}}));
        }
      });
    JS
  }
  let(:app) {
    sw = worker
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'        then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'   then [200, {'content-type' => 'text/javascript'}, [sw]]
        else                 [200, {'content-type' => 'text/html'}, ['<html><body>from-network</body></html>']]
        end
      }
    }.to_app
  }

  before { skip 'SW navigation interception needs per-frame realms (V8 engine)' unless CsimEngine.v8? }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  # Register the SW at /scope/, wait for activation, load doc A (controlled), navigate to doc B
  # via `src=`, then `history.go(-1)` back to A. Returns [bodyA, bodyBack] textContents.
  def run_traversal(session)
    session.execute_script(<<~JS)
      globalThis.__done = false; globalThis.__a = null; globalThis.__back = null;
      (async () => {
        const reg = await navigator.serviceWorker.register('/sw.js', {scope: '/scope/'});
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe'); f.src = '/scope/a.html'; document.body.appendChild(f);
        await new Promise(res => { f.onload = res; });
        globalThis.__a = f.contentDocument.body.textContent;
        await new Promise(res => { f.onload = res; f.src = '/scope/b.html'; });
        await new Promise(res => { f.onload = res; f.contentWindow.history.go(-1); });
        globalThis.__back = f.contentDocument.body.textContent;
        globalThis.__done = true;
      })();
    JS
    30.times { break if session.evaluate_script('globalThis.__done === true'); sleep 0.03 }
    [session.evaluate_script('globalThis.__a'), session.evaluate_script('globalThis.__back')]
  end

  it 'history.go(-1) back into scope is a history navigation; the initial load is not' do
    Capybara.app = app
    session = simulated_session(app)
    session.visit '/'
    a, back = run_traversal(session)
    expect(a).to eq('hist=false')      # initial load is not a history navigation
    expect(back).to eq('hist=true')    # traversing back to doc A is
  end
end
