# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An image a controlling service worker answers loads from its response's bytes — a network response passed on, and one
# whose body is a stream the worker made (its chunks drained, then decoded).
RSpec.describe 'a service worker image' do
  include PollUntil

  png = File.binread(File.expand_path('wpt/common/square.png', __dir__))
  worker = <<~JS
    self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', (e) => {
      const path = new URL(e.request.url).pathname;
      if (path.endsWith('/streamed.png')) {
        e.respondWith(fetch('/real.png').then((r) => r.arrayBuffer()).then((b) => new Response(new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(b)); c.close(); }
        }), {headers: {'content-type': 'image/png'}})));
      } else if (path.endsWith('/buffered.png')) {
        e.respondWith(fetch('/real.png'));
      }
    });
  JS
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js'    then [200, {'content-type' => 'text/javascript'}, [worker]]
      when '/real.png' then [200, {'content-type' => 'image/png'}, [png]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  # (…every host served in-process, which a service worker's job is scheduled under alone: browser.rb `sw_schedule_job`'s
  # `all_hosts_local?`)
  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it 'loads from a response passed on and from a stream the worker made' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.got = null;
      navigator.serviceWorker.register('/sw.js', {scope: '/scope/'}).then(async (reg) => {
        const w = reg.installing || reg.waiting || reg.active;
        await new Promise((res) => {
          if (w.state === 'activated') return res();
          w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
        });
        const frame = document.body.appendChild(document.createElement('iframe'));
        frame.src = '/scope/page.html';
        frame.onload = async () => {
          const doc = frame.contentDocument, out = {};
          for (const name of ['buffered', 'streamed']) {
            out[name] = await new Promise((res) => {
              const img = doc.createElement('img');
              img.onload = () => res('load ' + img.naturalWidth);
              img.onerror = () => res('error');
              img.src = '/scope/' + name + '.png';
              doc.body.appendChild(img);
            });
          }
          window.got = out;
        };
      });
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq('buffered' => 'load 100', 'streamed' => 'load 100')
  end
end
