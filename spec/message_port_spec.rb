# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# MessagePort and BroadcastChannel (HTML §9.4–9.5): a port's messages follow it wherever it is transferred — within a
# realm, to a frame, to a worker and on from there — and a BroadcastChannel post is a task.
RSpec.describe 'MessagePort' do
  # An echo worker: a port sent to it answers each message with `echo:<data>`, and a `send` message posts on.
  echo = <<~JS
    onmessage = (e) => {
      if (e.data === 'port') e.ports[0].onmessage = (m) => e.ports[0].postMessage('echo:' + m.data);
      if (e.data === 'make') {
        const ch = new MessageChannel();
        ch.port1.onmessage = (m) => ch.port1.postMessage('echo:' + m.data);
        postMessage('made', [ch.port2]);
      }
    };
  JS
  page = <<~HTML
    <!doctype html><meta charset="utf-8"><body><script>
    window.log = [];
    window.worker = () => new Worker(URL.createObjectURL(new Blob([#{echo.to_json}], {type: 'text/javascript'})));
    </script></body>
  HTML

  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit('/')
    s
  }

  def logged(count)
    poll_until(timeout: 5) { session.evaluate_script('window.log.length') >= count }
    session.evaluate_script('window.log')
  end

  it 'carries the messages a port held into the worker it is transferred to' do
    session.execute_script(<<~JS)
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => log.push(e.data);
      ch.port1.postMessage('before');
      worker().postMessage('port', [ch.port2]);
      ch.port1.postMessage('after');
    JS
    expect(logged(2)).to eq(%w[echo:before echo:after])
  end

  it 'keeps a port received from a worker working where the page moves it on' do
    session.execute_script(<<~JS)
      const w = worker();
      w.onmessage = (e) => {
        const carrier = new MessageChannel();
        carrier.port2.onmessage = (c) => {
          const port = c.ports[0];
          port.onmessage = (m) => log.push(m.data);
          port.postMessage('moved');
        };
        carrier.port1.postMessage('carry', [e.ports[0]]);
      };
      w.postMessage('make');
    JS
    expect(logged(1)).to eq(['echo:moved'])
  end

  it "connects two workers by a page's channel" do
    session.execute_script(<<~JS)
      const a = worker(), relay = new Worker(URL.createObjectURL(new Blob([
        "onmessage = (e) => { const p = e.ports[0]; p.onmessage = (m) => postMessage('relay:' + m.data); p.postMessage('hello'); };"
      ], {type: 'text/javascript'})));
      relay.onmessage = (e) => log.push(e.data);
      const ch = new MessageChannel();
      a.postMessage('port', [ch.port1]);
      relay.postMessage('port', [ch.port2]);
    JS
    expect(logged(1)).to eq(['relay:echo:hello'])
  end

  it 'delivers a message already queued to a port that a transfer then moves' do
    session.execute_script(<<~JS)
      const a = new MessageChannel(), carrier = new MessageChannel();
      a.port1.onmessage = () => log.push('old port');
      a.port2.postMessage('in-flight');
      carrier.port2.onmessage = (c) => { c.ports[0].onmessage = (m) => log.push(m.data); };
      carrier.port1.postMessage('carry', [a.port1]);
    JS
    expect(logged(1)).to eq(['in-flight'])
  end

  it 'keeps the order of a message already queued to a port and one posted after a transfer moved it' do
    session.execute_script(<<~JS)
      const a = new MessageChannel(), carrier = new MessageChannel();
      a.port1.onmessage = (e) => log.push('old:' + e.data);
      a.port2.postMessage('x');
      carrier.port2.onmessage = (c) => { c.ports[0].onmessage = (m) => log.push('moved:' + m.data); };
      carrier.port1.postMessage('carry', [a.port1]);
      a.port2.postMessage('y');
    JS
    expect(logged(2)).to eq(%w[moved:x moved:y])
  end

  it 'carries a message already queued to an enabled port into the worker it is transferred to' do
    session.execute_script(<<~JS)
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => log.push(e.data);
      ch.port2.onmessage = () => log.push('kept');
      ch.port1.postMessage('in-flight');
      worker().postMessage('port', [ch.port2]);
    JS
    expect(logged(1)).to eq(['echo:in-flight'])
  end

  # A message on its way to a worker as it gives the port's end away reaches the end's next holder — once.
  it 'delivers each message once while a worker hands a port back' do
    session.execute_script(<<~JS)
      const w = new Worker(URL.createObjectURL(new Blob([
        "onmessage = (e) => { const p = e.ports[0]; p.onmessage = (m) => postMessage('worker:' + m.data); setTimeout(() => postMessage('back', [p]), 0); };"
      ], {type: 'text/javascript'})));
      const ch = new MessageChannel();
      w.onmessage = (e) => {
        if (e.data !== 'back') return log.push(e.data);
        e.ports[0].onmessage = (m) => log.push('page:' + m.data);
        setTimeout(() => log.push('done'), 300);
      };
      w.postMessage('take', [ch.port2]);
      ch.port1.postMessage('m1');
      setTimeout(() => ch.port1.postMessage('m2'), 100);
    JS
    poll_until(timeout: 5) { session.evaluate_script('window.log.includes("done")') }
    got = session.evaluate_script('window.log') - ['done']
    expect(got.map { _1.split(':').last }.sort).to eq(%w[m1 m2])
  end

  # StructuredSerializeWithTransfer: the transfer list checked before anything moves, and a port only by transfer.
  it "refuses a worker message's bad transfer list and untransferred port, moving no port" do
    expect(session.evaluate_script(<<~JS)).to eq(%w[DataCloneError DataCloneError DataCloneError DataCloneError open])
      (() => {
        const w = worker(), ch = new MessageChannel(), closed = new MessageChannel().port1, out = [];
        closed.close();
        const attempt = (f) => { try { f(); out.push('posted'); } catch (e) { out.push(e.name); } };
        attempt(() => w.postMessage(1, [closed]));
        attempt(() => w.postMessage(1, [ch.port1, ch.port1]));
        attempt(() => w.postMessage({p: ch.port1}));
        attempt(() => w.postMessage({p: ch.port1, f: () => {}}, [ch.port1]));
        ch.port1.postMessage('still here');
        out.push(new MessageChannel() && 'open');
        return out;
      })()
    JS
  end

  it 'sends nothing from a closed port to its peer in a worker' do
    session.execute_script(<<~JS)
      const w = new Worker(URL.createObjectURL(new Blob([
        "onmessage = (e) => { e.ports[0].onmessage = (m) => postMessage('got:' + m.data); };"
      ], {type: 'text/javascript'})));
      w.onmessage = (e) => {
        log.push(e.data);
        ch.port1.close();
        ch.port1.postMessage('closed');
        ch.port1.postMessage('closed');
        setTimeout(() => log.push('done'), 500);
      };
      const ch = new MessageChannel();
      w.postMessage('port', [ch.port2]);
      ch.port1.postMessage('open');
    JS
    expect(logged(2)).to eq(%w[got:open done])
  end

  it 'posts to a port whose peer went with a removed frame without throwing' do
    session.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.srcdoc = '<script>onmessage = (e) => { e.ports[0].onmessage = () => {}; parent.log.push("wired"); };<\\/script>';
      f.onload = () => {
        window.ch = new MessageChannel();
        f.contentWindow.postMessage('take', '*', [ch.port2]);
      };
      document.body.append(f);
    JS
    logged(1)
    expect(session.evaluate_script(<<~JS)).to eq('ok')
      (() => {
        document.querySelector('iframe').remove();
        ch.port1.postMessage('to nobody');
        return 'ok';
      })()
    JS
  end

  # HTML's MessagePort has no `onclose`: the close event was withdrawn, and Chrome and Firefox expose none.
  it 'has no onclose' do
    expect(session.evaluate_script("'onclose' in MessagePort.prototype")).to be(false)
  end
end

RSpec.describe 'BroadcastChannel' do
  # Each post is a task of the receiving channel's realm (HTML "queue a global task") — after the tasks queued before
  # it, and each with its microtask checkpoint. It was a microtask, ahead of all of them.
  it 'delivers a post as a task' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']] })
    session.visit('/')
    session.execute_script(<<~JS)
      window.log = [];
      const a = new BroadcastChannel('c'), b = new BroadcastChannel('c');
      b.onmessage = (e) => { log.push('bc:' + e.data); Promise.resolve().then(() => log.push('microtask')); };
      setTimeout(() => log.push('timer'));
      a.postMessage(1);
      a.postMessage(2);
      Promise.resolve().then(() => log.push('poster'));
    JS
    poll_until { session.evaluate_script('window.log.length') >= 6 }
    expect(session.evaluate_script('window.log')).to eq(%w[poster timer bc:1 microtask bc:2 microtask])
  end
end
