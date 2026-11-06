# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A SharedWorker connects to the shared worker of its constructor URL and name in its storage key where one runs (HTML
# "SharedWorker constructor"), a frame's of the page's as well: one global, a `connect` for each; another name or URL is
# another worker; one of another type fails the constructor's worker with an `error` event, no connection. Chrome 156
# and Firefox 159 alike (measured 2026-11-02). It lives while any document connected to it does (its owner set): the
# frame that made it removed, the page's connection still answers.
RSpec.describe 'SharedWorker matching' do
  include PollUntil

  let(:app) {
    count = <<~JS
      let n = 0;
      onconnect = (e) => {
        const mine = ++n;
        e.ports[0].onmessage = () => e.ports[0].postMessage(`conn${mine}/of${n}`);
      };
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/count.js' then [200, {'content-type' => 'text/javascript'}, [count]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
      end
    }
  }

  def run(session, script)
    session.execute_script(<<~JS)
      window.got = null;
      const ask = (w) => new Promise((res) => { w.port.onmessage = (e) => res(e.data); w.port.postMessage('n'); });
      const frame = () => new Promise((res) => {
        const f = document.body.appendChild(document.createElement('iframe'));
        f.src = '/frame';
        f.onload = () => res(f);
      });
      (async () => { #{script} })().then((v) => { window.got = v; }, (e) => { window.got = String(e); });
    JS
    poll_until { session.evaluate_script('window.got') }
  end

  # (…HTML: "workerGlobalScope's credentials is not equal to options["credentials"]", Chrome and Firefox measured 2026-11-06)
  it 'fails a SharedWorker of another credentials mode than the one running' do
    session = simulated_session(app)
    session.visit '/'
    got = run(session, <<~JS)
      const a = new SharedWorker('/count.js', { name: 'c', credentials: 'same-origin' });
      const first = await ask(a);
      const other = await new Promise((res) => {
        const m = new SharedWorker('/count.js', { name: 'c', credentials: 'include' });
        m.onerror = (e) => res(`error ${e.constructor.name}`);
        m.port.onmessage = (e) => res(`message ${e.data}`);
        m.port.postMessage('n');
      });
      return [first, other, await ask(new SharedWorker('/count.js', { name: 'c' })), await ask(new SharedWorker('/count.js', 'c'))];
    JS
    expect(got).to eq(['conn1/of1', 'error Event', 'conn2/of2', 'conn3/of3'])
  end

  # (…a next document's channels none of the last one's, whose ends were left held by a worker discarded with it)
  it 'answers the first SharedWorker of a page after the last page\'s was discarded' do
    session = simulated_session(app)
    session.visit '/'
    expect(run(session, "return await ask(new SharedWorker('/count.js', 'a'));")).to eq('conn1/of1')
    session.visit '/next'
    expect(run(session, "return await ask(new SharedWorker('/count.js', 'b'));")).to eq('conn1/of1')
  end

  it 'connects a SharedWorker of the same URL and name to the one running' do
    session = simulated_session(app)
    session.visit '/'
    got = run(session, <<~JS)
      const a = new SharedWorker('/count.js');
      const b = new SharedWorker('/count.js');
      const out = [await ask(a), await ask(b), await ask(new SharedWorker('/count.js', 'other')), await ask(new SharedWorker('/count.js?x'))];
      const f = await frame();
      out.push(await ask(new f.contentWindow.SharedWorker('/count.js')));
      out.push(await new Promise((res) => {
        const m = new SharedWorker('/count.js', { type: 'module' });
        m.onerror = (e) => res(`error ${e.constructor.name}`);
        m.port.onmessage = (e) => res(`message ${e.data}`);
        m.port.postMessage('n');
      }));
      return out;
    JS
    expect(got).to eq(['conn1/of2', 'conn2/of2', 'conn1/of1', 'conn1/of1', 'conn3/of3', 'error Event'])
  end

  it 'keeps the worker while a document connected to it lives' do
    session = simulated_session(app)
    session.visit '/'
    got = run(session, <<~JS)
      const f = await frame();
      const first = await ask(new f.contentWindow.SharedWorker('/count.js'));
      const page = new SharedWorker('/count.js');
      const second = await ask(page);
      f.remove();
      await new Promise((res) => setTimeout(res, 50));
      return [first, second, await ask(page)];
    JS
    expect(got).to eq(['conn1/of1', 'conn2/of2', 'conn2/of2'])
  end
end
