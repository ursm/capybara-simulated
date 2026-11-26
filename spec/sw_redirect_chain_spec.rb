# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A redirect a service worker answers with is followed through the worker again (Fetch "HTTP fetch" → Handle Fetch, then
# "HTTP-redirect fetch", main fetch again): its next hop is the worker's to answer, the network's where it lets it
# through — for an image, a script, an EventSource as for a fetch() (sw_request.rs `SwChain`). And a raced navigation's
# network leg is "fetch given request", its redirect handed to the navigation: no ok status, so the handler's answer is
# the one the navigation takes. Chrome 158 measured all of it (the worker saw /a.png then /b.png, /s1.js then /s2.js,
# /es1 then /es2; the network served /b.png, /s2.js, /es2; the raced frame showed the handler's page, the network asked
# /racenav alone).
RSpec.describe 'a redirect a service worker answers with' do
  let(:worker) {
    <<~JS
      self.addEventListener('install', e => {
        e.addRoutes({condition: {urlPattern: new URLPattern({pathname: '/racenav*'})}, source: 'race-network-and-fetch-handler'});
        self.skipWaiting();
      });
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      const seen = [];
      self.addEventListener('fetch', e => {
        const p = new URL(e.request.url).pathname;
        seen.push(p);
        const to = {'/a.png': '/b.png', '/s1.js': '/s2.js', '/es1': '/es2', '/m1.mjs': '/m2.mjs'}[p];
        if (to) e.respondWith(Response.redirect(to, 302));
        if (p === '/p1') e.respondWith(new Response(null, {status: 302, headers: {location: new URL('/p2', self.location).href, 'referrer-policy': 'no-referrer'}}));
        if (p === '/racenav') {
          e.respondWith(new Promise(r => setTimeout(() => r(new Response('<!doctype html><meta charset=utf-8><body>handler page', {headers: {'content-type': 'text/html'}})), 200)));
        }
      });
      self.addEventListener('message', e => e.ports[0].postMessage(seen));
    JS
  }
  let(:requests) { [] }
  let(:referers) { {} }
  let(:app) {
    sw       = worker
    log      = requests
    referers = self.referers
    png = ['89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082'].pack('H*')
    lambda {|env|
      path = env['PATH_INFO']
      log << path
      referers[path] = env['HTTP_REFERER']
      case path
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [sw]]
      when '/b.png' then [200, {'content-type' => 'image/png'}, [png]]
      when '/s2.js' then [200, {'content-type' => 'text/javascript'}, ['window.s2ran = true;']]
      when '/m2.mjs' then [200, {'content-type' => 'text/javascript'}, ['window.m2ran = true;']]
      when '/p2' then [200, {'content-type' => 'text/plain'}, ['p2']]
      when '/es2' then [200, {'content-type' => 'text/event-stream'}, ["data: hello\n\n"]]
      when '/racenav' then [302, {'location' => '/elsewhere'}, []]
      when '/elsewhere' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>network elsewhere']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>page']]
      end
    }
  }

  def controlled_session
    session = simulated_session(app)
    session.visit '/'
    session.execute_script("navigator.serviceWorker.addEventListener('controllerchange', () => { globalThis.__controlled = true; }); navigator.serviceWorker.register('/sw.js');")
    expect(poll_until { session.evaluate_script('globalThis.__controlled === true') }).to be(true)
    session
  end

  def seen(session)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const channel = new MessageChannel();
      channel.port1.onmessage = e => done(e.data);
      navigator.serviceWorker.controller.postMessage(null, [channel.port2]);
    JS
  end

  it 'is the worker\'s again at its next hop, the network\'s where it lets that through: an image, a script, an EventSource' do
    session = controlled_session
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const img = new Image(); img.src = '/a.png';
        const imgOk = await new Promise(r => { img.onload = () => r('load ' + img.naturalWidth); img.onerror = () => r('error'); });
        const s = document.createElement('script'); s.src = '/s1.js';
        const sOk = await new Promise(r => { s.onload = () => r('load ' + window.s2ran); s.onerror = () => r('error'); document.body.append(s); });
        const es = new EventSource('/es1');
        const esOk = await new Promise(r => { es.onmessage = (e) => { r('msg ' + e.data); es.close(); }; es.onerror = () => { r('error'); es.close(); }; });
        return [imgOk, sOk, esOk];
      })().then(done, (e) => done(String(e)));
    JS
    expect(got).to eq(['load 1', 'load true', 'msg hello'])
    expect(seen(session)).to include('/a.png', '/b.png', '/s1.js', '/s2.js', '/es1', '/es2')
    expect(requests).to include('/b.png', '/s2.js', '/es2')
    expect(requests).not_to include('/a.png', '/s1.js', '/es1')
  end

  # …and a module script's, its graph's fetch the host's: the request at the hop sent as the page's (its Origin the
  # page's, a module script's fetch being CORS).
  it "is the worker's again for a module script, its hop let through the page's request" do
    session = controlled_session
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const s = document.createElement('script'); s.type = 'module'; s.src = '/m1.mjs';
      s.onload = () => done('load ' + window.m2ran); s.onerror = () => done('error');
      document.body.append(s);
    JS
    expect(got).to eq('load true')
    expect(seen(session)).to include('/m1.mjs', '/m2.mjs')
    expect(requests).to include('/m2.mjs')
  end

  # HTTP-redirect fetch "set request's referrer policy on redirect" (the response's Referrer-Policy), then main fetch
  # "determine request's referrer" again for the hop: the worker sees, and the network is sent, the hop's.
  it "takes a redirect's Referrer-Policy for the next hop, its referrer determined again" do
    session = controlled_session
    expect(session.evaluate_async_script("const d = arguments[0]; fetch('/p1').then(r => r.text()).then(d, e => d(String(e)))")).to eq('p2')
    expect(seen(session)).to include('/p1', '/p2')
    expect(requests).not_to include('/p1')
    expect(referers.fetch('/p2')).to be_nil
  end

  it "hands a raced navigation's redirect to the navigation: the handler's answer, the network asked once" do
    session = controlled_session
    requests.clear
    session.execute_script("const f = document.createElement('iframe'); f.src = '/racenav'; document.body.append(f);")
    text = poll_until(timeout: 10) { session.evaluate_script("document.querySelector('iframe').contentDocument?.body?.textContent") }
    expect(text).to eq('handler page')
    expect(requests).to include('/racenav')
    expect(requests).not_to include('/elsewhere')
  end
end
