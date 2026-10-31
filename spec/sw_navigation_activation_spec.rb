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
# virtual time, at no wall time of its own (where the navigation waits in place: one a script makes, which can't block,
# deferred until the worker activates).
RSpec.describe 'a navigation into the scope of an activating service worker', :every_host_local, :https do
  include PollUntil

  let(:activation_ms) { 80_000 }
  let(:session) do
    activation_ms = self.activation_ms
    simulated_session(lambda {|env|
      html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/sw.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', (e) => e.waitUntil(new Promise((r) => setTimeout(r, #{activation_ms}))));
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
            navigator.serviceWorker.register('/sw.js', {scope: '/'}).then((r) => {
              const worker = r.installing || r.waiting || r.active;
              const seen = () => { if (worker.state === 'activating') document.title = 'activating'; };
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

  it "waits on a noopener window's first" do
    session.find('#blank').click
    session.within_window(session.windows.last) { expect(session).to have_title('FROM-SW') }
  end
end
