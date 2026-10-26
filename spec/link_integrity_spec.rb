# frozen_string_literal: true

require 'capybara/simulated'
require 'digest'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A link's `integrity` is its request's integrity metadata (HTML "create link options from element"), whatever the
# link's type, and a response that does not match it is a network error (Fetch "main fetch", SRI "does response match
# metadataList?"): the link's `error`, no sheet made of it — a preload's of any destination, its consumer taking that
# network error. Chrome and Firefox: the sheet's and the style preload's `error`, the sheet not applied; both take an
# image preload's response whatever its integrity, which the spec does not.
RSpec.describe 'link integrity' do
  include PollUntil

  let(:css)  { 'p { color: red }' }
  let(:good) { "sha256-#{Digest::SHA256.base64digest(css)}" }
  let(:bad)  { "sha256-#{'A' * 43}=" }

  it 'loads a link whose response matches its integrity and refuses one that does not' do
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/css'}, [css]] if env['PATH_INFO'] == '/s.css'
      next [200, {'content-type' => 'image/png'}, [File.binread(File.expand_path('wpt/resource-timing/resources/blue.png', __dir__))]] if env['PATH_INFO'] == '/i.png'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><p>p</p>']]
    }).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      window.events = [];
      for (const [rel, as, href, integrity] of [['stylesheet', '', '/s.css?bad', '#{bad}'], ['preload', 'style', '/s.css?pre', '#{bad}'],
                                                ['preload', 'image', '/i.png', '#{bad}'], ['preload', 'style', '/s.css?good', '#{good}']]) {
        const link = Object.assign(document.createElement('link'), { rel, href, integrity });
        if (as) link.as = as;
        link.onload = () => events.push(href + ':load');
        link.onerror = () => events.push(href + ':error');
        document.head.append(link);
      }
    JS
    expect(poll_until { s.evaluate_script('events.length === 4') }).to be true
    expect(s.evaluate_script("[events.sort(), getComputedStyle(document.querySelector('p')).color]")).to eq([
      ['/i.png:error', '/s.css?bad:error', '/s.css?good:load', '/s.css?pre:error'], 'rgb(0, 0, 0)'
    ])
    s.execute_script("document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/s.css?good', integrity: '#{good}' }))")
    expect(poll_until { s.evaluate_script("getComputedStyle(document.querySelector('p')).color === 'rgb(255, 0, 0)'") }).to be true
  end

  # …on every leg that answers a sheet: the preload of it, a `data:` and a `blob:` URL's — the sheet not applied and the
  # link's `error`, as its load and the cascade agree — and under the integrity its request was made with, set as the
  # link is inserted (Chrome: a change of it after is no fetch again: `error`); a module preload's of none its import
  # map's. Chrome: every one of them `error`, none applied.
  it 'refuses a sheet failing its integrity whatever answered it, its integrity as its request was made' do
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/css'}, [css]] if env['PATH_INFO'] == '/s.css'
      next [200, {'content-type' => 'text/javascript'}, ['export {}']] if env['PATH_INFO'] == '/m.js'

      page = <<~HTML
        <!DOCTYPE html><meta charset=utf-8>
        <script type=importmap>{"integrity": {"/m.js": "#{bad}", "/m.js?empty": "#{bad}"}}</script><body><p>p</p>
      HTML
      [200, {'content-type' => 'text/html'}, [page]]
    }).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      window.events = [];
      const blob = URL.createObjectURL(new Blob([#{css.to_json}], { type: 'text/css' }));
      const data = 'data:text/css,' + encodeURIComponent(#{css.to_json});
      for (const [rel, as, href, integrity] of [['preload', 'style', '/s.css?pre', '#{bad}'], ['stylesheet', '', '/s.css?pre', '#{bad}'],
                                                ['stylesheet', '', data, '#{bad}'], ['stylesheet', '', blob, '#{bad}'],
                                                ['stylesheet', '', '/s.css?changed', '#{bad}'], ['modulepreload', '', '/m.js', null]]) {
        const link = Object.assign(document.createElement('link'), { rel, href });
        if (integrity !== null) link.integrity = integrity;
        if (as) link.as = as;
        const name = rel + ':' + href.split(/[,?]/)[0].slice(0, 9) + (href.includes('?') ? '?' + href.split('?')[1] : '');
        link.onload = () => events.push(name + ':load');
        link.onerror = () => events.push(name + ':error');
        document.head.append(link);
        if (href.endsWith('changed')) link.integrity = '#{good}';
      }
    JS
    expect(poll_until { s.evaluate_script('events.length === 6') }).to be true
    expect(s.evaluate_script("[events.every((e) => e.endsWith(':error')), getComputedStyle(document.querySelector('p')).color]")).to eq([true, 'rgb(0, 0, 0)'])
    # (…an `integrity` attribute of none, an empty one, no import map's: HTML "if el does not have an integrity attribute")
    s.execute_script(<<~'JS')
      const link = Object.assign(document.createElement('link'), { rel: 'modulepreload', href: '/m.js?empty', integrity: '' });
      link.onload = () => { window.empty = 'load'; };
      link.onerror = () => { window.empty = 'error'; };
      document.head.append(link);
    JS
    expect(poll_until { s.evaluate_script('window.empty') }).to eq('load')
  end

  # A service worker's answer is hashed as the bytes it is, not as its text: a sheet of Latin-1 bytes under a digest of
  # them loads and applies (Chrome: `load`).
  it "matches a worker's answer by its bytes" do
    latin = "p::before { content: '\xE9' } p { color: red }".b
    digest = "sha256-#{Digest::SHA256.base64digest(latin)}"
    worker = <<~JS
      self.addEventListener('install', () => self.skipWaiting());
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        if (!e.request.url.endsWith('/latin.css')) return;
        const bytes = new Uint8Array(#{latin.bytes.to_json});
        e.respondWith(new Response(bytes, { headers: { 'content-type': 'text/css; charset=iso-8859-1' } }));
      });
    JS
    page = '<!DOCTYPE html><meta charset=utf-8><body><p>p</p><script>navigator.serviceWorker.register("/sw.js"); setInterval(() => {}, 50);</script>'
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # Service Workers are modeled only in a universal-server context
    begin
      s = simulated_session(lambda {|env|
        env['PATH_INFO'] == '/sw.js' ? [200, {'content-type' => 'text/javascript'}, [worker]] : [200, {'content-type' => 'text/html'}, [page]]
      }).tap {|session| session.visit '/' }
      expect(poll_until { s.evaluate_script('!!navigator.serviceWorker.controller') }).to be true
      s.execute_script(<<~JS)
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/latin.css', integrity: '#{digest}' });
        link.onload = () => { window.result = 'load'; };
        link.onerror = () => { window.result = 'error'; };
        document.head.append(link);
      JS
      expect(poll_until { s.evaluate_script('window.result') }).to eq('load')
      expect(s.evaluate_script("getComputedStyle(document.querySelector('p')).color")).to eq('rgb(255, 0, 0)')
    ensure
      ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
    end
  end
end
