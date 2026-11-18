# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# A traversal whose frame's document is made by a navigation the host deferred on a service worker still activating —
# made again once the worker activates, after the traversal's step ended — that then makes no document (a 204): the
# frame is held at the entry it was at, its document's, as one whose document the step made none of is (HTML "apply the
# history step" waits for every document the step makes; session_history.rs `late`). A traversal forward again then
# moves the frame nowhere: none of its documents fetched again.
RSpec.describe 'a traversal whose frame makes no document once its worker activates', :every_host_local, :https do
  include PollUntil

  let(:hits) { Hash.new(0) }
  let(:session) do
    hits = self.hits
    simulated_session(lambda {|env|
      hits[env['PATH_INFO']] += 1
      html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/sw.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', (e) => e.waitUntil(new Promise((r) => self.addEventListener('message', (m) => { if (m.data === 'go') r(); }))));
          self.addEventListener('fetch', (e) => {
            if (new URL(e.request.url).pathname === '/sw/f1') e.respondWith(new Response(null, {status: 204}));
          });
        JS
      when '/top' then html.('<title>top</title><iframe src="/sw/f1"></iframe>')
      when '/reg'
        html.(<<~HTML)
          <script>
            navigator.serviceWorker.register('/sw.js', {scope: '/sw/'}).then((r) => {
              const worker = r.installing || r.waiting || r.active;
              const seen = () => { if (worker.state === 'activating' || worker.state === 'activated') parent.document.title = worker.state; };
              seen();
              worker.addEventListener('statechange', seen);
            });
          </script>
        HTML
      else html.("<title>NET#{env['PATH_INFO']}</title>")
      end
    })
  end

  def read(expr) = session.evaluate_script(expr)

  it 'holds the frame at the entry it was at' do
    session.visit('https://a.test/top')
    session.execute_script("frames[0].location = '/sw/f2'")
    expect(poll_until { read('frames[0].location.pathname') == '/sw/f2' }).to be(true)
    session.execute_script("const r = document.createElement('iframe'); r.src = '/reg'; document.body.append(r)")
    expect(poll_until { read('document.title') == 'activating' }).to be(true)
    session.go_back
    expect(read('frames[0].location.pathname')).to eq('/sw/f2')
    session.execute_script("navigator.serviceWorker.getRegistration('/sw/').then((r) => (r.active || r.waiting || r.installing).postMessage('go'))")
    expect(poll_until { read('document.title') == 'activated' }).to be(true)
    expect(read('frames[0].location.pathname')).to eq('/sw/f2')
    before = hits['/sw/f2']
    session.go_forward
    expect(read('frames[0].location.pathname')).to eq('/sw/f2')
    expect(hits['/sw/f2']).to eq(before)
  end
end
