# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A module script's response must be of the MIME type its kind's is — a JavaScript one for a script, a JSON one for a
# JSON module, `text/css` for a CSS one, each that one alone — whoever answered it (HTML "fetch a single module
# script"): a `modulepreload` of anything else fails, as its module would; one whose `as` names a destination no module
# preload is (`image`) fetches nothing and fails, and one whose `media` does not match fetches nothing — until a change
# of its `media` matches; and a module a service worker answers as `text/plain` is no module either. (Chrome and the
# upstream WPT preload/modulepreload.html: `module1.js` as `style` or `json` fails.)
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
      when '/data.json' then [200, {'content-type' => 'application/json'}, ['{"a": 1}']]
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
      const cases = [
        ['/plain.js', null], ['/mod.js', null], ['/sheet.css', 'style'], ['/mod.js', 'style'], ['/mod.js', 'json'],
        ['/data.json', 'json'], ['/data.json', null], ['/mod.js', 'image'], ['/mod.js', 'bogus'], ['/mod.js', null, 'not all']
      ];
      for (const [href, as, media] of cases) {
        const link = document.createElement('link');
        link.rel = 'modulepreload';
        if (as) link.as = as;
        if (media) link.media = media;
        link.href = href;
        const label = href + ':' + (as || '') + (media ? '@' + media : '');
        link.onload = () => seen.push(label + ' load');
        link.onerror = () => seen.push(label + ' error');
        document.head.appendChild(link);
      }
    JS
    # (…the one whose `media` does not match fetching nothing and firing nothing — the second plain one, after it, does)
    session.execute_script(<<~JS)
      const late = document.createElement('link');
      late.rel = 'modulepreload';
      late.href = '/mod.js?late';
      late.onload = () => seen.push('late load');
      document.head.appendChild(late);
    JS
    got = poll_until { (s = session.evaluate_script('window.seen')).size == 10 && s }
    expect(got.sort).to eq([
      '/data.json: error',
      '/data.json:json load',
      '/mod.js: load',
      '/mod.js:bogus load',
      '/mod.js:image error',
      '/mod.js:json error',
      '/mod.js:style error',
      '/plain.js: error',
      '/sheet.css:style load',
      'late load'
    ])
  end

  it 'fetches a modulepreload its media skipped once a change makes it match, and a stylesheet whatever its media' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.seen = [];
      const link = (rel, href, as, media, label) => {
        const l = document.createElement('link');
        l.rel = rel;
        l.href = href;
        if (as) l.as = as;
        l.media = media;
        l.onload = () => seen.push(label + ' load');
        l.onerror = () => seen.push(label + ' error');
        document.head.appendChild(l);
        return l;
      };
      const changed = link('modulepreload', '/mod.js?changed', null, 'not all', 'changed');
      const removed = link('modulepreload', '/mod.js?removed', null, 'not all', 'removed');
      link('stylesheet modulepreload', '/sheet.css', 'style', 'not all', 'both');
      setTimeout(() => { changed.setAttribute('media', 'all'); removed.removeAttribute('media'); }, 100);
    JS
    got = poll_until { (s = session.evaluate_script('window.seen')).size == 3 && s }
    expect(got.sort).to eq(['both load', 'changed load', 'removed load'])
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
  # …a `data:` or `blob:` module's its URL's, or its blob's type — fetched by no network, each one's own response (Fetch
  # "scheme fetch") — a static import of one, a dynamic one, and a blob module importing over the network; a blob of no
  # type is no module (Chrome: "Expected a JavaScript module script but the server responded with a MIME type of """).
  it 'is a data: or blob: URL’s own' do
    session = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/javascript'}, ['export default 5;']] if env['PATH_INFO'] == '/five.js'
      next [200, {'content-type' => 'text/javascript'}, ['import "data:text/javascript,window.dataran=1";']] if env['PATH_INFO'] == '/d.js'

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><script>
          window.log = [];
          const url = (type) => URL.createObjectURL(new Blob(['import f from "http://www.example.com/five.js"; window.blobran = f;'], {type}));
          import(url('text/javascript')).then(() => log.push('blob ' + window.blobran), () => log.push('blob failed'));
          import(url('')).then(() => log.push('untyped ran'), () => log.push('untyped failed'));
          import('data:text/javascript,window.dyndata=2').then(() => log.push('data ' + window.dyndata));
        </script>
        <script type="module" src="/d.js" onload="log.push('static ' + window.dataran)" onerror="log.push('static error')"></script>
      HTML
    })
    session.visit '/'
    expect(poll_until { (l = session.evaluate_script('log')).size == 4 && l.sort }).to eq(['blob 5', 'data 2', 'static 1', 'untyped failed'])
  end
end
