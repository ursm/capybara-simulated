# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/js_engine'
require 'rack'
require 'json'
require_relative 'support/session_teardown'

# The service-worker UPDATE lifecycle: registering a new script at a scope that already has an
# active worker must NOT hand the new worker the running documents. HTML's "try activate" holds it
# in the WAITING slot until the outgoing worker has no controllees left, or until it calls
# `skipWaiting()`. `registration.waiting` being non-null is how every "a new version is available,
# reload?" banner detects an update — before this it was always null, so that whole flow was
# invisible.
RSpec.describe 'Service Worker update lifecycle' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        case req.path_info
        when '/'                then [200, {'content-type' => 'text/html'}, ['<html><body>main</body></html>']]
        when '/scope/page.html' then [200, {'content-type' => 'text/html'}, ['<html><body>in-scope</body></html>']]
        when '/scope/sw.js'
          # `?v=` makes each registration a distinct script url, i.e. a genuine update.
          # v2 calls skipWaiting() so one spec can release the gate from the worker side.
          body = +"self.__v = #{req.params['v'].inspect};"
          body << 'self.addEventListener("install", () => self.skipWaiting());' if req.params['skip']
          [200, {'content-type' => 'text/javascript'}, [body]]
        else [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { skip 'Service Worker lifecycle needs per-frame realms (V8 engine)' unless CsimEngine.v8? }

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  # Registers v1, activates it, and puts a CONTROLLED frame under it — the controllee is what makes
  # the incoming worker wait. Then registers `update_url`.
  def session_with_update(update_url)
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__state = null;
      const activated = reg => new Promise(res => {
        const w = reg.installing || reg.waiting || reg.active;
        if (!w || w.state === 'activated') return res();
        w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
      });
      (async () => {
        const r1 = await navigator.serviceWorker.register('/scope/sw.js?v=1', {scope: '/scope/'});
        await activated(r1);
        await new Promise(res => {
          const f = document.createElement('iframe');
          f.id = 'a'; f.src = '/scope/page.html';
          f.addEventListener('load', res, {once: true});
          document.body.appendChild(f);
        });
        globalThis.__reg = await navigator.serviceWorker.register(#{JSON.generate(update_url)}, {scope: '/scope/'});
        globalThis.__state = 'registered';
      })();
    JS
    60.times do
      break if session.evaluate_script("globalThis.__state === 'registered'")

      sleep 0.02
    end
    expect(session.evaluate_script('globalThis.__state')).to eq('registered')
    session
  end

  def slots(session)
    session.evaluate_script(<<~JS)
      (() => {
        const r = globalThis.__reg;
        const v = w => w ? (w.scriptURL.match(/[?&]v=(\\d+)/) || [])[1] || '?' : null;
        return {waiting: v(r.waiting), active: v(r.active), installing: v(r.installing)};
      })()
    JS
  end

  it 'holds an update in the waiting slot while the old worker still controls a client' do
    session = session_with_update('/scope/sw.js?v=2')
    10.times { session.evaluate_script('1') }   # the gate must HOLD, not merely lag

    expect(slots(session)).to eq({'waiting' => '2', 'active' => '1', 'installing' => nil})
  end

  # `skipWaiting()` is the escape hatch every app uses to ship an update immediately.
  it 'activates an update that calls skipWaiting, without waiting for the client to go' do
    session = session_with_update('/scope/sw.js?v=2&skip=1')
    40.times do
      break if session.evaluate_script("globalThis.__reg.active && globalThis.__reg.active.scriptURL.includes('v=2')")

      sleep 0.02
    end

    expect(slots(session)['active']).to eq('2')
    expect(slots(session)['waiting']).to be_nil
  end

  # The other half of "try activate": the update takes over once the outgoing worker's last
  # controllee is gone.
  it 'activates a waiting update once the last controlled client goes away' do
    session = session_with_update('/scope/sw.js?v=2')
    expect(slots(session)['waiting']).to eq('2')

    session.execute_script("document.getElementById('a').remove();")
    40.times do
      break if session.evaluate_script("globalThis.__reg.active && globalThis.__reg.active.scriptURL.includes('v=2')")

      sleep 0.02
    end

    expect(slots(session)).to eq({'waiting' => nil, 'active' => '2', 'installing' => nil})
  end
end
