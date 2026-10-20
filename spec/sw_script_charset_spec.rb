# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A classic script a controlling service worker answers is decoded as a network one is — by its response's Content-Type
# charset (script.rs `classic_script_encoding`) — whether the parser fetched it or a script inserted it: its bytes and
# its Content-Type, not a text the host made of them.
RSpec.describe 'Service Worker script charset' do
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
      });
    JS
    page = '<!DOCTYPE html><meta charset="utf-8"><script src="/scope/parsed.js"></script><body>'
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, [page]]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'decodes a served script by its Content-Type charset, parsed or inserted' do
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
          s.onload = () => { globalThis.__got = [f.contentWindow.parsed, f.contentWindow.inserted]; };
          f.contentDocument.body.appendChild(s);
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__got') }).to eq(%w[名 名])
  end
end
