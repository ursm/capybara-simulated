# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What the bindings keep for an event target — its listeners, its event handlers' values — is no property of it: a page
# enumerating an element, the window or an XMLHttpRequest sees none of it, as in Chrome or Firefox. A frame's window
# keeps its handlers whichever realm's view of it set them.
RSpec.describe 'event target state' do
  let(:app) {
    lambda {|env|
      body = env['PATH_INFO'] == '/frame' ? 'frame' : '<iframe src="/frame"></iframe><div id="d"></div>'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    }
  }

  it 'keeps a target’s listeners and handlers off its own properties' do
    s = simulated_session(app)
    s.visit '/'
    names = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d'), xhr = new XMLHttpRequest();
        for (const t of [d, window, xhr]) {
          t.addEventListener('click', () => {});
          t.onclick = () => {};
        }
        d.setAttribute('onmouseover', 'void 0');
        const own = (o) => Object.getOwnPropertyNames(o).filter((n) => /^_(eh|ehw|listeners|rare)/.test(n));
        return [own(d), own(window), own(xhr)];
      })()
    JS
    expect(names).to eq([[], [], []])
  end

  it 'fires a handler set through another realm’s view of a frame’s window, in order with its listeners' do
    s = simulated_session(app)
    s.visit '/'
    seen = s.evaluate_script(<<~JS)
      (() => {
        const seen = [], w = frames[0];
        w.onerror = () => { seen.push('handler'); return true; };
        w.addEventListener('error', (e) => seen.push('listener ' + e.defaultPrevented));
        const e = new ErrorEvent('error', {cancelable: true});
        w.dispatchEvent(e);
        seen.push(w.eval('typeof onerror'));
        return seen;
      })()
    JS
    expect(seen).to eq(['handler', 'listener true', 'function'])
  end
end
