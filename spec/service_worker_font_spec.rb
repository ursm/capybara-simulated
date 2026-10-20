# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A web font a controlling service worker answers is drawn from that answer's bytes — one the network has no file at
# (404) too — whether a stylesheet's `@font-face` or a script's FontFace asked: the download and the face's fetch are
# one dispatch, and the bytes it answered were thrown away, the network asked again.
RSpec.describe 'a web font a service worker answers' do
  ahem = File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => {
        if (new URL(e.request.url).pathname === '/scope/sw-only.ttf') e.respondWith(fetch('/ahem.ttf'));
      });
    JS
    page = <<~HTML
      <!doctype html><meta charset="utf-8">
      <style>@font-face { font-family: SwOnly; src: url(sw-only.ttf); } body { margin: 0 }</style>
      <span id="t" style="font: 20px SwOnly">abcd</span>
    HTML
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/ahem.ttf' then [200, {'content-type' => 'font/ttf'}, [ahem]]
      when '/scope/sw-only.ttf' then [404, {'content-type' => 'text/plain'}, ['no']]
      when '/scope/page.html' then [200, {'content-type' => 'text/html'}, [page]]
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

  it 'draws the face from the answer’s bytes, for a stylesheet’s face and a script’s' do
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
          const W = frame.contentWindow, doc = frame.contentDocument;
          const width = doc.getElementById('t').getBoundingClientRect().width;
          const face = new W.FontFace('Scripted', 'url(sw-only.ttf)');
          let status;
          try { await face.load(); status = face.status; } catch (e) { status = 'rejected ' + e.name; }
          window.got = [width, status];
        };
      });
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq([80, 'loaded'])
  end
end
