# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/https_app_host'
require_relative 'support/every_host_local'

# A service worker registration is the session's, of its storage key — not the window's whose script made it — and its
# worker one isolate, whichever window began it (Browser#sw_host): a `noopener` window (a browsing context group, and a
# Browser, of its own) sees the registration its opener made, is controlled by it, its messages and fetches answered
# and a MessageChannel's port carried to it; and one a cross-site pop-up (a Browser of its own) made is the one every
# later document of its storage key sees.
RSpec.describe "the session's service workers", :every_host_local, :https do
  include PollUntil

  let(:session) do
    simulated_session(lambda {|env|
      html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]] }
      case env['PATH_INFO']
      when '/sw.js'
        [200, {'content-type' => 'text/javascript'}, [<<~JS]]
          self.addEventListener('message', (e) => {
            if (e.ports[0]) e.ports[0].postMessage('port:' + e.data);
            else e.source.postMessage('source:' + e.data);
          });
          self.addEventListener('fetch', (e) => {
            const path = new URL(e.request.url).pathname;
            if (path.startsWith('/sw/')) e.respondWith(new Response('<title>FROM-SW</title>', {headers: {'content-type': 'text/html'}}));
            if (path === '/sub') e.respondWith(new Response('SUB-SW'));
          });
        JS
      when '/reg'
        html.(<<~HTML)
          <title>reg</title><a id=talk href=/talk target=_blank>talk</a><a id=nav href=/sw/x target=_blank>nav</a>
          <script>navigator.serviceWorker.register('/sw.js', {scope: '/'}).then(() => navigator.serviceWorker.ready).then(() => document.title = 'ready')</script>
        HTML
      when '/talk'
        html.(<<~HTML)
          <title>talk</title>
          <script>
            const heard = [];
            const show = () => document.title = heard.sort().join(',');
            navigator.serviceWorker.onmessage = (e) => { heard.push(e.data); show(); };
            navigator.serviceWorker.getRegistrations().then(async (all) => {
              heard.push('n=' + all.length);
              const r = await navigator.serviceWorker.ready;
              const channel = new MessageChannel();
              channel.port1.onmessage = (e) => { heard.push(e.data); show(); };
              r.active.postMessage('a', [channel.port2]);
              r.active.postMessage('b');
              const text = await (await fetch('/sub')).text();
              heard.push('fetch:' + text);
              show();
            });
          </script>
        HTML
      when '/count' then html.("<script>navigator.serviceWorker.getRegistrations().then((r) => document.title = 'n=' + r.length)</script>")
      else html.("<title>NET#{env['PATH_INFO']}</title>")
      end
    })
  end

  def read(expr) = session.evaluate_script(expr)

  it "is a noopener window's too: seen, controlling it, answering its messages, fetches and ports" do
    session.visit 'https://a.test/reg'
    expect(session).to have_title('ready')
    session.find('#talk').click
    session.within_window(session.windows.last) do
      expect(session).to have_title('fetch:SUB-SW,n=1,port:a,source:b')
    end
    session.find('#nav').click
    session.within_window(session.windows.last) { expect(session).to have_title('FROM-SW') }
  end

  it "made in a cross-site pop-up, is every later document's of its storage key" do
    session.visit 'https://b.test/'
    session.execute_script("window.w = open('https://a.test/reg')")
    session.within_window(session.windows.last) { expect(session).to have_title('ready') }
    session.execute_script("open('https://a.test/count', '', 'noopener')")
    session.within_window(session.windows.last) { expect(session).to have_title('n=1') }
    session.visit 'https://a.test/count'
    expect(session).to have_title('n=1')
  end
end
