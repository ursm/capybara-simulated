# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame navigated into a scope whose service worker is still activating waits for it (Handle Fetch waits for
# `activated`): its build is parked, and replayed once the worker activates — each parked frame of every realm, in the
# order it was parked, the frames of a frame's document as the top's (frame_navigation.rs `takeSwDeferredFrames`).
RSpec.describe 'a frame parked on an activating service worker' do
  include PollUntil

  HTML_DEFERRED = {'content-type' => 'text/html; charset=utf-8'}.freeze
  APP_DEFERRED = lambda {|env|
    case env['PATH_INFO']
    when '/' then [200, HTML_DEFERRED, ['<!doctype html><meta charset=utf-8><body>main</body>']]
    when '/outer.html' then [200, HTML_DEFERRED, ['<!doctype html><meta charset=utf-8><body>outer</body>']]
    when '/scope/page.html' then [200, HTML_DEFERRED, ['<!doctype html><meta charset=utf-8><body>in-scope</body>']]
    when '/scope/sw.js'
      worker = 'self.addEventListener("fetch", () => {}); ' \
               'self.addEventListener("activate", (e) => e.waitUntil(new Promise((res) => { self.addEventListener("message", res); })));'
      [200, {'content-type' => 'text/javascript'}, [worker]]
    else [404, {'content-type' => 'text/plain'}, ['nope']]
    end
  }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  def loads(in_frame)
    session = simulated_session(APP_DEFERRED)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__got = null;
      globalThis.__log = [];
      (async () => {
        const outer = await new Promise((res) => {
          const f = document.createElement('iframe');
          f.src = '/outer.html';
          f.onload = () => res(f);
          document.body.appendChild(f);
        });
        const reg = await navigator.serviceWorker.register('/scope/sw.js', {scope: '/scope/'});
        const w = reg.installing;
        await new Promise((res) => {
          if (w.state === 'activating') return res();
          w.addEventListener('statechange', () => { if (w.state === 'activating') res(); });
        });
        const doc = #{in_frame ? 'outer.contentDocument' : 'document'};
        const parked = ['a', 'b'].map((n) => new Promise((res) => {
          const f = doc.createElement('iframe');
          f.src = '/scope/page.html?' + n;
          f.addEventListener('load', () => { __log.push(n + ' ' + f.contentDocument.body.textContent); res(); });
          doc.body.appendChild(f);
        }));
        setTimeout(() => w.postMessage('go'), 50);
        await Promise.all(parked);
        globalThis.__got = __log;
      })();
    JS
    poll_until { session.evaluate_script('globalThis.__got') }
  end

  it 'loads each once the worker activates, in the order they were parked' do
    expect(loads(false)).to eq(['a in-scope', 'b in-scope'])
  end

  it "loads a frame's document's too" do
    expect(loads(true)).to eq(['a in-scope', 'b in-scope'])
  end
end
