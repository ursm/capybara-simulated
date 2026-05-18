# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'json'

# Web Worker round-trip coverage: spawn isolate, post messages each
# way, terminate. The driver creates a fresh V8 Context / QuickJS VM
# per Worker; postMessage payloads JSON-marshal across the
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

  def poll_for(session, script, timeout: 2)
    deadline = Time.now + timeout
    last = nil
    until Time.now > deadline
      last = session.evaluate_script(script)
      return last if yield(last)
      sleep 0.05
    end
    last
  end

  it 'spawns a worker and round-trips a postMessage' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__r = null;
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__r = e.data; };
      w.postMessage({cmd: 'echo', value: 'hello'});
    JS
    result = poll_for(session, 'window.__r') {|v| v == {'echo' => 'hello'} }
    expect(result).to eq({'echo' => 'hello'})
  end

  it 'runs computation in the worker and returns the result' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__sumRes = null;
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__sumRes = e.data; };
      w.postMessage({cmd: 'compute', n: 100});
    JS
    result = poll_for(session, 'window.__sumRes') {|v| v == {'sum' => 5050} }
    expect(result).to eq({'sum' => 5050})
  end

  it 'supports addEventListener("message") on the worker scope' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    session.execute_script(<<~JS)
      window.__res = [];
      const w = new Worker('/worker.js');
      w.onmessage = (e) => { window.__res.push(e.data); };
      w.postMessage({cmd: 'addEventListener'});
      w.postMessage({hello: 'world'});
    JS
    arr = poll_for(session, 'JSON.stringify(window.__res)', timeout: 3) {|raw|
      a = JSON.parse(raw)
      a.include?({'addedListener' => true}) && a.any? {|e| e['viaListener'] == {'hello' => 'world'} }
    }
    parsed = JSON.parse(arr)
    expect(parsed).to include({'addedListener' => true})
    expect(parsed).to include({'viaListener' => {'hello' => 'world'}})
  end

  it 'terminate() kills the worker thread' do
    session = Capybara::Session.new(:simulated, app)
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
end
