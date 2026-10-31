# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# Handle Fetch: "If activeWorker's state is "activating", wait for activeWorker's state to become "activated"" — every
# navigation into the scope of a worker still activating waits for it, whatever navigates: a visit (Chrome's address-bar
# navigation does, measured), a script's, a frame's, a window `window.open` made in the page's isolate, a `noopener`
# window's first (a Browser of its own) — and however long the worker's `activate` waitUntil runs, in the session's
# virtual time, at no wall time of its own, or real work it does (a task running, a fetch) takes (where the navigation
# waits in place: one a script makes, which can't block, deferred until the worker activates). A navigation deferred so
# is made only while it is its navigable's ongoing navigation: one begun since, a traversal or a reload, replaced it.
RSpec.describe 'a navigation into the scope of an activating service worker', :every_host_local, :https do
  include PollUntil

  let(:activation_ms) { 80_000 }
  let(:activate) { "new Promise((r) => setTimeout(r, #{activation_ms}))" }
  let(:session) do
    activate = self.activate
    simulated_session(lambda {|env|
      html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/sw.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', (e) => e.waitUntil(#{activate}));
          self.addEventListener('fetch', (e) => {
            if (new URL(e.request.url).pathname.startsWith('/sw/')) {
              e.respondWith(new Response('<!doctype html><title>FROM-SW</title>', {headers: {'content-type': 'text/html'}}));
            }
          });
        JS
      when '/reg'
        html.(<<~HTML)
          <title>reg</title><a id=blank href=/sw/blank target=_blank>blank</a>
          <script>
            navigator.serviceWorker.register('/sw.js', {scope: '/sw/'}).then((r) => {
              const worker = r.installing || r.waiting || r.active;
              const seen = () => { if (worker.state === 'activating') document.title = 'activating'; };
              seen();
              worker.addEventListener('statechange', seen);
            });
          </script>
        HTML
      when '/slow'
        sleep 0.2
        [200, {'content-type' => 'text/plain'}, ['ok']]
      else html.("<title>NET#{env['PATH_INFO']}</title>")
      end
    })
  end

  def read(expr) = session.evaluate_script(expr)

  before do
    session.visit 'https://a.test/reg'
    expect(poll_until { read('document.title') == 'activating' }).to be(true)
  end

  it 'waits on a visit' do
    session.visit 'https://a.test/sw/visit'
    expect([session.title, read('!!navigator.serviceWorker.controller')]).to eq(['FROM-SW', true])
  end

  it "waits on a script's" do
    session.execute_script("location.href = '/sw/location'")
    expect(session).to have_title('FROM-SW')
  end

  # (…a frame's built in a script, which no wait may block: deferred, made again as the worker activates — as the page's
  # clock moves on)
  context 'with a shorter activation' do
    let(:activation_ms) { 500 }

    it "waits on a frame's" do
      session.execute_script("const f = document.createElement('iframe'); f.src = '/sw/frame'; document.body.append(f)")
      expect(session).to have_css('iframe')
      expect(poll_until { read('frames[0]?.document.title') == 'FROM-SW' }).to be(true)
    end
  end

  it "waits on a window's `window.open` made in the page's isolate" do
    session.execute_script("window.w = open('/sw/pop')")
    expect(poll_until { read('w.document.title') == 'FROM-SW' }).to be(true)
  end

  context 'with an activation that works: a task running' do
    let(:activate) { '(async () => { let x = 0; for (let i = 0; i < 1e8; i++) x += i; return x; })()' }

    it 'waits on a visit, in place' do
      session.visit 'https://a.test/sw/visit'
      expect([session.title, session.current_url]).to eq(['FROM-SW', 'https://a.test/sw/visit'])
    end
  end

  context 'with an activation that works: a fetch' do
    let(:activate) { "fetch('/slow').then((r) => r.text())" }

    it 'waits on a visit, in place' do
      session.visit 'https://a.test/sw/visit'
      expect([session.title, session.current_url]).to eq(['FROM-SW', 'https://a.test/sw/visit'])
    end
  end

  context 'with an activation that waits on a page' do
    let(:activate) { "new Promise((r) => self.addEventListener('message', (m) => { if (m.data === 'go') r(); }))" }

    def activate!
      session.execute_script("navigator.serviceWorker.getRegistration('/sw/').then((r) => (r.active || r.waiting || r.installing).postMessage('go'))")
    end

    it 'makes a deferred visit once the worker activates' do
      session.visit 'https://a.test/sw/visit'
      expect(session.title).to eq('activating')
      activate!
      expect(session).to have_title('FROM-SW')
    end

    it 'makes none another navigation replaced' do
      session.visit 'https://a.test/sw/first'
      session.visit 'https://a.test/second'
      expect(session.title).to eq('NET/second')
      activate!
      expect(session.has_title?('FROM-SW', wait: 0.5)).to be(false)
      expect(session.current_url).to eq('https://a.test/second')
    end

    it 'makes none a reload replaced' do
      session.execute_script("location.href = '/sw/first'")
      session.execute_script('location.reload()')
      expect(session).to have_title('activating')
      activate!
      expect(session.has_title?('FROM-SW', wait: 0.5)).to be(false)
      expect(session.current_url).to eq('https://a.test/reg')
    end
  end

  it "waits on a noopener window's first" do
    session.find('#blank').click
    session.within_window(session.windows.last) { expect(session).to have_title('FROM-SW') }
  end
end
