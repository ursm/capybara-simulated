# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A version's lifecycle step tells every realm of each worker's new state in turn (Service Workers "Update Worker
# State", a task per realm): a realm that first makes its ServiceWorker of a worker in a `statechange` listener of
# another one in the same step makes it in the state before, and sees its own `statechange` after — a waiting worker
# retired as a newer one is installed, its redundant listener taking the registration's new waiting worker.
RSpec.describe 'Service Worker lifecycle order' do
  include PollUntil

  let(:app) {
    version = 0
    lambda {|env|
      case env['PATH_INFO']
      when '/sw.js'
        version += 1
        [200, {'content-type' => 'text/javascript'}, ["// v#{version}\nself.addEventListener('install', () => {});"]]
      when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>in scope']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>page']]
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

  it "fires a statechange for a worker a listener of another's in the same step first sees" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__log = [];
      const settled = (w, state) => new Promise((res) => { const step = () => (w.state === state ? res() : w.addEventListener('statechange', step, {once: true})); step(); });
      (async () => {
        const reg = await navigator.serviceWorker.register('/sw.js', {scope: '/scope/'});
        await settled(reg.installing || reg.waiting || reg.active, 'activated');
        const f = document.createElement('iframe');
        f.src = '/scope/page.html';
        await new Promise((res) => { f.onload = res; document.body.appendChild(f); });
        await reg.update();
        await settled(reg.installing || reg.waiting, 'installed');
        // (…the frame's realm knows the waiting worker alone; a newer one installing retires it)
        const freg = await f.contentWindow.navigator.serviceWorker.getRegistration('/scope/');
        const w2 = freg.waiting;
        w2.addEventListener('statechange', () => {
          const w3 = freg.waiting;
          __log.push(`w2 ${w2.state} / waiting ${w3 && w3.state}`);
          w3?.addEventListener('statechange', () => __log.push(`w3 ${w3.state}`));
        });
        await reg.update();
        await settled(reg.waiting, 'installed');
        await new Promise((res) => setTimeout(res, 100));
        __log.push('done');
      })();
    JS
    expect(poll_until { session.evaluate_script("globalThis.__log.includes('done') && globalThis.__log") }).to eq(['w2 redundant / waiting installing', 'w3 installed', 'done'])
  end
end
