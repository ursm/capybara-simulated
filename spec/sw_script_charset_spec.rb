# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A classic script a controlling service worker answers is decoded as a network one is — by its response's Content-Type
# charset (script.rs `classic_script_encoding`) — whether the parser fetched it or a script inserted it: its bytes and
# its Content-Type, not a text the host made of them — and refused as a network one is: a `nosniff` one of no JavaScript
# type is a network error.
# (…service Workers are modeled only in a universal-server context)
RSpec.describe 'Service Worker script charset', :every_host_local do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        // (…"window.<name> = '名'" in Shift_JIS: 名 is 0x96 0xBC)
        const bytes = (name) => new Uint8Array([...new TextEncoder().encode('window.' + name + " = '"), 0x96, 0xBC, 0x27, 0x3B]);
        if (u.pathname === '/scope/parsed.js') e.respondWith(new Response(bytes('parsed'), {headers: {'content-type': 'text/javascript; charset=shift_jis'}}));
        else if (u.pathname === '/scope/inserted.js') e.respondWith(new Response(bytes('inserted'), {headers: {'content-type': 'text/javascript; charset=shift_jis'}}));
        else if (u.pathname === '/scope/empty.js') e.respondWith(new Response('', {headers: {'content-type': 'text/javascript'}}));
        else if (u.pathname === '/scope/sniffed.js') e.respondWith(new Response('window.sniffed = 1;', {headers: {'content-type': 'text/plain', 'x-content-type-options': 'nosniff'}}));
      });
    JS
    page = '<!DOCTYPE html><meta charset="utf-8"><script src="/scope/parsed.js"></script><body>'
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, [page]]
        when '/scope/empty.js'  then [200, {'content-type' => 'text/javascript'}, ['window.fromNetwork = true;']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  it 'decodes a served script by its Content-Type charset, parsed or inserted, and refuses one nosniff fails' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__got = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const s = f.contentDocument.createElement('script');
          s.src = '/scope/inserted.js';
          s.onload = () => {
            // (…and one whose `nosniff` its text/plain type fails, as a network response's does)
            const n = f.contentDocument.createElement('script');
            n.src = '/scope/sniffed.js';
            n.onerror = () => { globalThis.__got = [f.contentWindow.parsed, f.contentWindow.inserted, 'error', f.contentWindow.sniffed ?? null]; };
            n.onload = () => { globalThis.__got = [f.contentWindow.parsed, f.contentWindow.inserted, 'load', f.contentWindow.sniffed ?? null]; };
            f.contentDocument.body.appendChild(n);
          };
          f.contentDocument.body.appendChild(s);
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__got') }).to eq(['名', '名', 'error', nil])
  end

  # …and an empty answer is the script's body: it loads, runs nothing, and the network is never asked.
  it 'takes an empty answer as the script it serves' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__got = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const W = f.contentWindow, s = f.contentDocument.createElement('script');
          s.src = '/scope/empty.js';
          s.onload = () => { globalThis.__got = ['load', W.fromNetwork ?? null]; };
          s.onerror = () => { globalThis.__got = ['error', W.fromNetwork ?? null]; };
          f.contentDocument.body.appendChild(s);
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__got') }).to eq(['load', nil])
  end
end
