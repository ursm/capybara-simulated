# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Web Worker round-trip coverage: spawn isolate, post messages each
# way, terminate. The driver creates a fresh V8 Context per Worker; postMessage payloads JSON-marshal across the
# isolate boundary.

RSpec.describe 'Web Worker' do
  let(:worker_js) {
    <<~JS
      self.onmessage = function(e) {
        const data = e.data;
        if (data && data.cmd === 'echo') {
          self.postMessage({echo: data.value});
        } else if (data && data.cmd === 'compute') {
          let sum = 0;
          for (let i = 1; i <= data.n; i++) sum += i;
          self.postMessage({sum});
        } else if (data && data.cmd === 'addEventListener') {
          self.addEventListener('message', e2 => {
            if (e2.data && e2.data.hello) self.postMessage({viaListener: e2.data});
          });
          self.postMessage({addedListener: true});
        }
      };
    JS
  }

  let(:app) {
    j  = worker_js
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'          then [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
        when '/worker.js' then [200, {'content-type' => 'application/javascript'}, [j]]
        else                   [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  it 'spawns a worker and round-trips a postMessage' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__r = null;
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__r = e.data; };
      w.postMessage({cmd: 'echo', value: 'hello'});
    JS
    poll_until { session.evaluate_script('window.__r !== null') }
    expect(session.evaluate_script('window.__r')).to eq({'echo' => 'hello'})
  end

  # A worker's own timers keep a wait going: it runs on its own thread and clock, and what it posts when they fire is
  # what the wait is for. With nothing pending on the page itself, the driver said it had nothing to wait for, and a
  # matcher gave up after the first message — the second, posted 300ms in, never arrived in time.
  it 'keeps waiting for what a worker posts from its timers' do
    html = '<html><body><div id="w"></div><script>' \
           'const wk = new Worker(URL.createObjectURL(new Blob(["setTimeout(() => postMessage(\'w1\'), 100); ' \
           'setTimeout(() => postMessage(\'w2\'), 300)"], {type: "text/javascript"})));' \
           'wk.onmessage = (e) => document.getElementById("w").append(e.data + " ");</script></body></html>'
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit('/')
    expect(session).to have_css('#w', text: 'w1 w2', wait: 3)
  end

  it 'runs computation in the worker and returns the result' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__sumRes = null;
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__sumRes = e.data; };
      w.postMessage({cmd: 'compute', n: 100});
    JS
    poll_until { session.evaluate_script('window.__sumRes !== null') }
    expect(session.evaluate_script('window.__sumRes')).to eq({'sum' => 5050})
  end

  it 'supports addEventListener("message") on the worker scope' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__res = [];
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__res.push(e.data); };
      w.postMessage({cmd: 'addEventListener'});
      w.postMessage({hello: 'world'});
    JS
    # Two separate deliveries — wait for both, then assert on the whole log.
    poll_until { session.evaluate_script('window.__res.length >= 2') }
    parsed = JSON.parse(session.evaluate_script('JSON.stringify(window.__res)'))
    expect(parsed).to include({'addedListener' => true})
    expect(parsed).to include({'viaListener' => {'hello' => 'world'}})
  end

  it 'terminate() kills the worker thread' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__t = null;
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__t = e.data; };
      w.terminate();
      w.postMessage({cmd: 'echo', value: 'should not arrive'});
    JS
    sleep 0.3
    expect(session.evaluate_script('window.__t')).to be_nil
  end
  # A JSON.parse reviver that returns `undefined` makes the parser DELETE the property, so an
  # `undefined` inside a postMessage payload arrived MISSING rather than present-and-undefined:
  # `[undefined, undefined, 'x']` came back as a 3-length array with HOLES at 0 and 1. `in` and
  # `hasOwnProperty` tell those apart, and so does anything reading a fixed-shape tuple — a
  # service worker reporting `client.visibilityState` for a non-window client sends exactly that.
  it 'keeps an undefined value PRESENT across postMessage rather than dropping the slot' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      globalThis.__got = null;
      const w = new Worker('/worker.js');
      w.onmessage = e => {
        if (!e.data || !e.data.echo) return;
        const a = e.data.echo.arr, o = e.data.echo.obj;
        globalThis.__got = {
          len:    a.length,
          present: [0, 1, 2].map(i => i in a),
          types:  [0, 1, 2].map(i => typeof a[i]),
          hasKey: 'u' in o,
          keyType: typeof o.u
        };
      };
      w.postMessage({cmd: 'echo', value: {arr: [undefined, undefined, 'x'], obj: {u: undefined, v: 1}}});
    JS
    poll_until { session.evaluate_script('globalThis.__got !== null') }
    got = session.evaluate_script('globalThis.__got') or raise 'the worker never echoed'

    expect(got['len']).to eq(3)
    expect(got['present']).to eq([true, true, true])
    expect(got['types']).to eq(%w[undefined undefined string])
    expect(got['hasKey']).to be(true)
    expect(got['keyType']).to eq('undefined')
  end

  # HTML: `postMessage(message, transfer)` carries the transferred ports — a MessagePort handed to a worker (a
  # Comlink-style RPC channel) arrives as `event.ports`, both ways, and talks across. They went as data alone: the
  # worker's `event.ports` was empty.
  it 'carries transferred MessagePorts to a worker and back' do
    worker_js = <<~JS
      onmessage = (e) => {
        const [port] = e.ports;
        port.onmessage = (ev) => port.postMessage('echo:' + ev.data);
        const back = new MessageChannel();
        back.port1.onmessage = (ev) => back.port1.postMessage('back:' + ev.data);
        postMessage('ports:' + e.ports.length, [back.port2]);
      };
    JS
    html = <<~HTML
      <!doctype html><meta charset="utf-8"><body><script>
      window.log = [];
      const w = new Worker(URL.createObjectURL(new Blob([#{worker_js.to_json}], {type: 'text/javascript'})));
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => window.log.push(e.data);
      w.onmessage = (e) => {
        window.log.push(e.data + '/' + e.ports.length);
        e.ports[0].onmessage = (ev) => window.log.push(ev.data);
        e.ports[0].postMessage(2);
        ch.port1.postMessage(1);
      };
      w.postMessage('port', [ch.port2]);
      </script></body>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit('/')
    poll_until(timeout: 5) { session.evaluate_script('window.log.length') >= 3 }
    expect(session.evaluate_script('window.log')).to contain_exactly('ports:1/1', 'echo:1', 'back:2')
  end
end
