# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A redirect a controlling service worker answers with is followed as Fetch's "HTTP-redirect fetch" follows one: a 303
# rewrites a request to a bodyless GET unless it is a GET or a HEAD already — a HEAD stays a HEAD (step 12), as the
# network's redirects (browser.rb) do.
RSpec.describe 'Service Worker redirect method' do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname === '/scope/r') e.respondWith(Response.redirect(new URL('/scope/t', u).href, 303));
        else if (u.pathname === '/scope/t') e.respondWith(new Response(null, {headers: {'x-method': e.request.method}}));
      });
    JS
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>in-scope</body></html>']]
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

  it 'keeps a HEAD a HEAD across a 303, and makes a POST a GET' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__methods = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = async () => {
          const methods = [];
          for (const method of ['HEAD', 'POST', 'GET']) {
            const r = await f.contentWindow.fetch('/scope/r', {method});
            methods.push(r.headers.get('x-method'));
          }
          globalThis.__methods = methods;
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__methods') }).to eq(%w[HEAD GET GET])
  end
end
