# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An event the UA fires from a task — a message, a request's progress, a load, a timeout's abort, a hash change, a
# user's click — runs its listeners with no script on the stack, so HTML's "clean up after running script" performs a
# microtask checkpoint after each of them: a promise the first listener resolves settles before the second runs. An
# event a script dispatches does not: its frame stays on the stack until the dispatch returns, through a listener of a
# task's event too. (Chrome, measured: each order below.)
RSpec.describe 'a task-fired event' do
  APP_CHECKPOINT = lambda {|env|
    case env['PATH_INFO']
    when '/data' then [200, {'content-type' => 'text/plain'}, ['x']]
    when '/s.js' then [200, {'content-type' => 'text/javascript'}, ['']]
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
end
