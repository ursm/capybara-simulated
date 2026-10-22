# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What answers a controlled client's request (fetch_rules.rs `fetch_route`): an http(s) URL its service worker, a
# `data:` URL its own processor, and any other scheme the network, which refuses it — Handle Fetch sees HTTP(S) requests
# alone, so a worker answering everything never answers `about:blank`, from fetch() or XHR.
RSpec.describe 'a controlled client’s request route' do
  include PollUntil

  let(:app) {
    worker = <<~JS
      self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', (e) => e.respondWith(new Response('sw')));
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js' then [200, {'content-type' => 'text/javascript'}, [worker]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
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

  it 'sends only an http(s) request to the worker' do
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
          for (const url of ['/scope/x', 'about:blank', 'data:,d']) {
            out.push(await W.fetch(url).then((r) => r.text(), () => 'error'));
          }
          out.push(await new Promise((res) => {
            const x = new W.XMLHttpRequest();
            x.open('GET', 'about:blank');
            x.onload = () => res(x.responseText);
            x.onerror = () => res('error');
            x.send();
          }));
          window.got = out;
        };
      });
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq(%w[sw error d error])
  end
end
