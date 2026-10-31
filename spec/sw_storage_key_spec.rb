# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# Every service worker registration, and every client, is of a storage key — an origin and the top-level site of the
# environment that made it (Storage "obtain a storage key"; sw_registry.rs) — which every lookup is of: a registration
# a third-party frame of other.test makes under a.test is none a first-party other.test document sees, whether the page
# navigated there or a same-site pop-up a redirect took there (a window of the page's isolate still: HTML keeps its
# browsing context group). Neither its navigations, nor its frames', nor its subresources are handled by that worker,
# and its `clients.matchAll()` lists none of their documents.
RSpec.describe 'the storage key of a service worker registration', :every_host_local, :https do
  include PollUntil

  let(:worker) do
    <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        if (new URL(e.request.url).pathname.startsWith('/sw/')) {
          e.respondWith(new Response('<!doctype html><title>FROM-SW</title>', {headers: {'content-type': 'text/html'}}));
        }
      });
      self.addEventListener('message', async (e) => {
        const all = await self.clients.matchAll({includeUncontrolled: true, type: 'all'});
        e.source.postMessage(all.map((c) => new URL(c.url).pathname).join(','));
      });
    JS
  end
  let(:session) do
    worker = self.worker
    simulated_session(lambda {|env|
      html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/top' then html.('<title>top</title><iframe src="https://other.test/reg"></iframe>')
      when '/reg'
        html.(<<~HTML)
          <script>
            navigator.serviceWorker.register('/sw.js', {scope: '/'}).then(async (r) => {
              await navigator.serviceWorker.ready;
              navigator.serviceWorker.addEventListener('message', (e) => parent.postMessage('clients:' + e.data, '*'));
              addEventListener('message', (e) => { if (e.data === 'ask') r.active.postMessage('x'); });
              parent.postMessage('ready', '*');
            });
          </script>
        HTML
      when '/redir' then [302, {'location' => 'https://other.test/plain'}, []]
      when '/plain' then html.("<title>plain</title><iframe src='https://other.test/sw/inner'></iframe>")
      when '/count' then html.("<script>navigator.serviceWorker.getRegistrations().then((r) => document.title = 'n=' + r.length)</script>")
      else html.("<title>NET#{env['PATH_INFO']}</title>")
      end
    })
  end

  def read(expr) = session.evaluate_script(expr)

  before do
    session.visit 'https://a.test/top'
    session.execute_script("window.msgs = []; addEventListener('message', (e) => msgs.push(e.data))")
    expect(poll_until { read('msgs').include?('ready') }).to be(true)
  end

  it "handles none of a first-party document's — a same-site pop-up a redirect took to that site — nor lists them" do
    session.execute_script("window.w = open('/redir')")
    popup = session.windows.last
    session.within_window(popup) do
      expect(session).to have_title('plain')
      expect(read('[frames[0].document.title, String(navigator.serviceWorker.controller)]')).to eq(['NET/sw/inner', 'null'])
    end
    session.execute_script("frames[0].postMessage('ask', '*')")
    expect(poll_until { read('msgs').find {|m| m.start_with?('clients:') } }).to eq('clients:/reg')
  end

  it 'is none a first-party document of its origin sees' do
    session.visit 'https://other.test/count'
    expect(poll_until { session.title.start_with?('n=') && session.title }).to eq('n=0')
  end
end
