# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An event the UA fires from a task — a message, a request's progress, a load, a timeout's abort, a hash change, a
# user's click — runs its listeners with no script on the stack, so HTML's "clean up after running script" performs a
# microtask checkpoint after each of them: a promise the first listener resolves settles before the second runs. An
# event a script dispatches does not: its frame stays on the stack until the dispatch returns, through a listener of a
# task's event too. (Chrome, measured: each order below.)
RSpec.describe 'a task-fired event' do
  WATCH_CHECKPOINT = <<~JS
    window.log = [];
    window.watch = (target, type, name) => {
      target.addEventListener(type, () => { log.push(name + '1'); Promise.resolve().then(() => log.push(name + '-micro')); });
      target.addEventListener(type, () => log.push(name + '2'));
    };
  JS
  # (…scripts from `data:` URLs, whose names hold spaces, and a worker's: script all the same)
  SCRIPTS_CHECKPOINT = <<~HTML
    <!DOCTYPE html><meta charset=utf-8><body><script>#{WATCH_CHECKPOINT}</script>
    <script src="data:text/javascript,'use strict'; const c = new AbortController(); watch(c.signal, 'abort', 'classic'); c.abort(); log.push('classic-end')"></script>
    <script type=module src="data:text/javascript,const c = new AbortController(); watch(c.signal, 'abort', 'module'); c.abort(); log.push('module-end')"></script>
    <script>
      const worker = new Worker("data:text/javascript,'use strict'; const l = []; const c = new AbortController(); c.signal.addEventListener('abort', () => { l.push('w1'); Promise.resolve().then(() => l.push('w-micro')) }); c.signal.addEventListener('abort', () => l.push('w2')); c.abort(); l.push('w-end'); setTimeout(() => postMessage(l.join(' ')), 0)");
      worker.onmessage = (e) => log.push(e.data);
    </script>
  HTML
  APP_CHECKPOINT = lambda {|env|
    case env['PATH_INFO']
    when '/data' then [200, {'content-type' => 'text/plain'}, ['x']]
    when '/s.js' then [200, {'content-type' => 'text/javascript'}, ['']]
    when '/scripts' then [200, {'content-type' => 'text/html'}, [SCRIPTS_CHECKPOINT]]
    when '/child' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><script>parent.log.push("child")</script>']]
    else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><button id=b>b</button>']]
    end
  }

  def session_at_root
    s = simulated_session(APP_CHECKPOINT)
    s.visit '/'
    s
  end

  def run(session, body)
    session.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [];
      const watch = (target, type, name) => {
        target.addEventListener(type, () => { log.push(name + '1'); Promise.resolve().then(() => log.push(name + '-micro')); });
        target.addEventListener(type, () => log.push(name + '2'));
      };
      #{body}
    JS
  end

  it "checkpoints between a message's listeners" do
    got = run(session_at_root, <<~JS)
      const ch = new MessageChannel();
      watch(ch.port1, 'message', 'port');
      ch.port1.start();
      ch.port2.postMessage(1);
      const bc = new BroadcastChannel('c'), other = new BroadcastChannel('c');
      watch(bc, 'message', 'bc');
      other.postMessage(1);
      setTimeout(() => { watch(window, 'message', 'win'); window.postMessage(1, '*'); setTimeout(() => done(log), 50); }, 50);
    JS
    expect(got).to eq(%w[port1 port-micro port2 bc1 bc-micro bc2 win1 win-micro win2])
  end

  it "checkpoints between a request's events, and a load's, an abort's and a hash change's listeners" do
    got = run(session_at_root, <<~JS)
      const steps = [
        (next) => {
          const x = new XMLHttpRequest();
          x.onreadystatechange = () => { if (x.readyState === 4) { log.push('rsc4'); Promise.resolve().then(() => log.push('rsc4-micro')); } };
          x.onload = () => { log.push('load'); Promise.resolve().then(() => log.push('load-micro')); };
          x.onloadend = () => { log.push('loadend'); next(); };
          x.open('GET', '/data');
          x.send();
        },
        (next) => {
          const r = new FileReader();
          watch(r, 'load', 'fr');
          r.onloadend = next;
          r.readAsText(new Blob(['x']));
        },
        (next) => {
          const s = document.createElement('script');
          watch(s, 'load', 'script');
          s.addEventListener('load', next);
          s.src = '/s.js';
          document.body.append(s);
        },
        (next) => {
          const signal = AbortSignal.timeout(1);
          watch(signal, 'abort', 'abort');
          signal.addEventListener('abort', () => setTimeout(next, 10));
        },
        (next) => {
          watch(window, 'hashchange', 'hash');
          window.addEventListener('hashchange', () => setTimeout(next, 10));
          location.hash = '#h';
        }
      ];
      const go = (i) => i < steps.length ? steps[i](() => go(i + 1)) : setTimeout(() => done(log), 10);
      go(0);
    JS
    expect(got).to eq(%w[
      rsc4 rsc4-micro load load-micro loadend
      fr1 fr-micro fr2
      script1 script-micro script2
      abort1 abort-micro abort2
      hash1 hash-micro hash2
    ])
  end

  it "checkpoints between a user's click's listeners, not a script's" do
    s = session_at_root
    s.execute_script(<<~JS)
      window.log = [];
      const b = document.getElementById('b');
      b.addEventListener('click', (e) => {
        log.push((e.isTrusted ? 'user' : 'script') + '1');
        Promise.resolve().then(() => log.push('micro'));
      });
      b.addEventListener('click', (e) => log.push((e.isTrusted ? 'user' : 'script') + '2'));
      // (…and a dispatch inside a task's listener has that listener's frame beneath it)
      const ch = new MessageChannel();
      ch.port1.onmessage = () => b.click();
      window.clickFromTask = () => ch.port2.postMessage(1);
    JS
    s.find('#b').click
    s.execute_script('log.push("|"); document.getElementById("b").click(); log.push("|"); clickFromTask()')
    got = s.evaluate_async_script('const done = arguments[0]; setTimeout(() => done(log), 50)')
    expect(got).to eq(%w[user1 micro user2 | script1 script2 | micro script1 script2 micro])
  end

  it "counts a script's dispatchEvent, a bound built-in listener, and every script of the page as script on the stack" do
    s = simulated_session(APP_CHECKPOINT)
    s.visit '/scripts'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      // (…a built-in a timer calls: its own execution context on the stack, though no frame of the page's is)
      watch(document.body, 'x', 'bound');
      setTimeout(EventTarget.prototype.dispatchEvent.bind(document.body, new Event('x')), 0);
      // (…and a listener that is one, of this realm's, clicking a frame's button: the agent's stack, whichever realm)
      const frame = document.createElement('iframe');
      frame.srcdoc = '<button>b</button>';
      frame.onload = () => {
        const button = frame.contentDocument.querySelector('button');
        watch(button, 'click', 'listener');
        const ch = new MessageChannel();
        ch.port1.addEventListener('message', HTMLElement.prototype.click.bind(button));
        ch.port1.start();
        ch.port2.postMessage(1);
      };
      document.body.append(frame);
      const poll = () => log.some((l) => l.startsWith('w')) && log.includes('listener-micro') ? done(log) : setTimeout(poll, 10);
      poll();
    JS
    worker, page = got.partition {|l| l.start_with?('w') }
    expect(page).to eq(%w[
      classic1 classic2 classic-end classic-micro module1 module2 module-end module-micro
      bound1 bound2 bound-micro listener1 listener2 listener-micro
    ])
    expect(worker).to eq(['w1 w2 w-end w-micro'])
  end

  # …and a built-in a page's timer calls (a bound click()), none of the page's frames beneath what it dispatches.
  it "counts a built-in a page's timer calls as script on the stack" do
    got = run(session_at_root, <<~JS)
      const b = document.getElementById('b');
      watch(b, 'click', 'click');
      setTimeout(HTMLElement.prototype.click.bind(b), 0);
      setTimeout(() => done(log), 50);
    JS
    expect(got).to eq(%w[click1 click2 click-micro])
  end

  # KNOWN GAP: both are fired from a microtask of the driver's (a frame's load after its build, the scroll events' flush
  # after the script that scrolled), where a checkpoint does nothing. Fired by their task itself instead, the frame's
  # teardown in its `load` handler (TreeWalker-acceptNode-filter-cross-realm-null-browsing-context, Blob-methods-from-
  # detached-frame) and a scrollend after a scroll its handler's microtask made
  # (scrollend-event-fired-after-instant-scroll-in-microtask) stop holding.
  it "checkpoints between a frame's load's listeners, and a scroll's" do
    pending "a frame's load and the scroll events are fired from a microtask of the driver's"
    got = run(session_at_root, <<~JS)
      document.body.style.height = '5000px';
      const f = document.createElement('iframe');
      watch(f, 'load', 'frame');
      f.addEventListener('load', () => setTimeout(() => {
        watch(window, 'scroll', 'scroll');
        scrollTo(0, 100);
        log.push('scrolled');
        setTimeout(() => done(log), 50);
      }, 10));
      f.src = '/child';
      document.body.append(f);
    JS
    expect(got - %w[child]).to eq(%w[frame1 frame-micro frame2 scrolled scroll1 scroll-micro scroll2])
  end

  it "checkpoints after a frame's script built under its parent's only once the parent's is done" do
    got = run(session_at_root, <<~JS)
      Promise.resolve().then(() => log.push('parent-micro'));
      const f = document.createElement('iframe');
      f.src = '/child';
      document.body.append(f);
      f.contentWindow.document;
      log.push('parent-end');
      setTimeout(() => done(log), 50);
    JS
    expect(got.index('parent-end')).to be < got.index('parent-micro')
  end
end
