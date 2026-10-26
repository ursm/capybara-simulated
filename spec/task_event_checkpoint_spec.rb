# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An event a task fires — a message's, a port's, a channel's, a window's postMessage — runs its listeners with no script
# on the stack, so HTML's "clean up after running script" performs a microtask checkpoint after each of them: a promise
# the first listener resolves settles before the second runs. An event a script dispatches does not: its frame stays
# on the stack until the dispatch returns.
RSpec.describe 'a task-fired event' do
  it 'checkpoints microtasks between its listeners' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [];
      const watch = (target, name) => {
        target.addEventListener('message', () => { log.push(name + '1'); Promise.resolve().then(() => log.push(name + '-micro')); });
        target.addEventListener('message', () => log.push(name + '2'));
      };
      const ch = new MessageChannel();
      watch(ch.port1, 'port');
      ch.port1.start();
      ch.port2.postMessage(1);
      const bc = new BroadcastChannel('c'), other = new BroadcastChannel('c');
      watch(bc, 'bc');
      other.postMessage(1);
      setTimeout(() => {
        watch(window, 'win');
        window.postMessage(1, '*');
        const t = document.createElement('div');
        t.addEventListener('click', () => { log.push('click1'); Promise.resolve().then(() => log.push('click-micro')); });
        t.addEventListener('click', () => log.push('click2'));
        setTimeout(() => { t.click(); setTimeout(() => done(log), 50); }, 50);
      }, 50);
    JS
    expect(got).to eq(%w[port1 port-micro port2 bc1 bc-micro bc2 win1 win-micro win2 click1 click2 click-micro])
  end
end
