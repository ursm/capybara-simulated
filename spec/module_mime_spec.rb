# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A module script's response must be of a MIME type a module of its kind is — a JavaScript one, a JSON one for a JSON
# module, `text/css` for a CSS one — whoever answered it (HTML "fetch a single module script"): a `modulepreload` of
# anything else fails, as its module would, and a module a service worker answers as `text/plain` is no module either.
RSpec.describe 'a module script’s MIME type' do
  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        const path = new URL(e.request.url).pathname;
        if (path === '/scope/plain.js') e.respondWith(new Response('window.ran = true;', { headers: { 'content-type': 'text/plain' } }));
        if (path === '/scope/good.js') e.respondWith(new Response('window.ran = true;', { headers: { 'content-type': 'text/javascript' } }));
      });
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/plain.js' then [200, {'content-type' => 'text/plain'}, ['export const x = 1;']]
      when '/mod.js' then [200, {'content-type' => 'text/javascript'}, ['export const x = 1;']]
      when '/sheet.css' then [200, {'content-type' => 'text/css'}, ['p { color: red }']]
      when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>in scope']]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>main']]
      end
    }
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'fails a modulepreload of a type its module is not' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.seen = [];
      for (const [href, as] of [['/plain.js', null], ['/mod.js', null], ['/sheet.css', 'style'], ['/mod.js', 'style']]) {
        const link = document.createElement('link');
        link.rel = 'modulepreload';
        if (as) link.as = as;
        link.href = href;
        link.onload = () => seen.push(href + ':' + (as || '') + ' load');
        link.onerror = () => seen.push(href + ':' + (as || '') + ' error');
        document.head.appendChild(link);
      }
    JS
    got = poll_until { (s = session.evaluate_script('window.seen')).size == 4 && s }
    expect(got.sort).to eq(['/mod.js: load', '/mod.js:style load', '/plain.js: error', '/sheet.css:style load'])
  end

  it 'runs no module a service worker answers as text/plain' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.got = null;
      navigator.serviceWorker.register('/sw.js', { scope: '/scope/' }).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => { if (w.state === 'activated') return res(); w.addEventListener('statechange', () => { if (w.state === 'activated') res(); }); });
        const frame = document.body.appendChild(document.createElement('iframe'));
        frame.src = '/scope/page.html';
        frame.onload = async () => {
          const W = frame.contentWindow, out = [];
          for (const url of ['/scope/plain.js', '/scope/good.js']) {
            W.ran = false;
            await new Promise((res) => {
              const script = frame.contentDocument.createElement('script');
              script.type = 'module';
              script.src = url;
              script.onload = () => { out.push(url + ' load ' + W.ran); res(); };
              script.onerror = () => { out.push(url + ' error ' + W.ran); res(); };
              frame.contentDocument.head.appendChild(script);
            });
          }
          window.got = out;
        };
      });
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq(['/scope/plain.js error false', '/scope/good.js load true'])
  end
end
