# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A redirect a controlling service worker answers with is followed as Fetch's "HTTP-redirect fetch" follows one: a 303
# rewrites a request to a bodyless GET unless it is a GET or a HEAD already — a HEAD stays a HEAD (step 12), as the
# network's redirects (browser.rb) do.
# (…service Workers are modeled only in a universal-server context)
RSpec.describe 'Service Worker redirect method', :every_host_local do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        const u = new URL(e.request.url);
        if (u.pathname === '/scope/r') e.respondWith(Response.redirect(new URL('/scope/t', u).href, 303));
        else if (u.pathname === '/scope/t') e.respondWith(new Response(null, {headers: {'x-method': e.request.method}}));
        else if (u.pathname === '/away') e.respondWith(new Response(null, {status: 307, headers: {location: 'http://b.example.com/on'}}));
        else if (u.pathname === '/on') e.respondWith(new Response(null, {status: 307, headers: {location: 'http://c.example.com/last'}}));
      });
    JS
    origins = self.origins
    Rack::Builder.new {
      run lambda {|env|
        origins << env['HTTP_ORIGIN'] if env['PATH_INFO'] == '/last'
        case Rack::Request.new(env).path_info
        when '/last'            then [200, {'content-type' => 'text/plain'}, ['last']]
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/sw.js'           then [200, {'content-type' => 'text/javascript'}, [worker]]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>in-scope</body></html>']]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  let(:origins) { [] }

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

  # An XMLHttpRequest follows a redirect the worker answers with as fetch() does: to the next hop, which the worker
  # answers too — a 303 of a POST a GET — its response redirected, at the last hop's URL, and its Resource Timing entry
  # named by the request's.
  it 'follows a redirect the worker answers an XMLHttpRequest with' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__xhr = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          const x = new f.contentWindow.XMLHttpRequest();
          x.open('POST', '/scope/r');
          x.onload = () => {
            const named = f.contentWindow.performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'xmlhttprequest').map((e) => new URL(e.name).pathname);
            globalThis.__xhr = [x.getResponseHeader('x-method'), new URL(x.responseURL).pathname, named];
          };
          x.send('body');
        };
        document.body.appendChild(f);
      });
    JS
    expect(poll_until { session.evaluate_script('globalThis.__xhr') }).to eq(['GET', '/scope/t', ['/scope/r']])
  end

  # A chain the worker leads off another origin than the request's and on to yet another taints the request's origin, and
  # the network hop it falls through on sends it so — "null" — whatever the request's mode.
  it 'carries the origin its redirects tainted to the network hop it falls through on' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__done = false;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async reg => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise(res => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        f.onload = () => {
          f.contentWindow.fetch('/away', {method: 'POST', mode: 'no-cors', body: 'x'}).finally(() => { globalThis.__done = true; });
        };
        document.body.appendChild(f);
      });
    JS
    poll_until { session.evaluate_script('globalThis.__done') }
    expect(origins).to eq(['null'])
  end
end
