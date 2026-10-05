# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Behaviours a review of the engine port found wrong beside it, each against Chrome: a window hears only the events of
# its own document's tree; an optgroup emptied wholesale resets its select; a shadow root's `mode` and `host` are
# read-only; `getAnimations()` keeps to its own tree; a removed frame's window is `closed`.
RSpec.describe 'review follow-ups' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe srcdoc="<p>x"></iframe>']] }) }

  before { session.visit '/' }

  it 'answers as Chrome does' do
    got = session.evaluate_script(<<~JS)
      (() => {
        let heard = 0;
        addEventListener('zz', () => heard++);
        document.createElement('div').dispatchEvent(new Event('zz', {bubbles: true}));
        document.implementation.createHTMLDocument('').body.dispatchEvent(new Event('zz', {bubbles: true}));
        document.body.dispatchEvent(new Event('zz', {bubbles: true}));
        const box = document.body.appendChild(document.createElement('div'));
        box.innerHTML = '<select><optgroup><option>a</option><option selected>b</option></optgroup><option>c</option></select>';
        const select = box.firstChild;
        select.firstChild.textContent = '';
        const host = box.appendChild(document.createElement('div'));
        const sr = host.attachShadow({mode: 'closed'});
        sr.mode = 'open';
        sr.host = null;
        sr.innerHTML = '<style>@keyframes x { to { opacity: 0 } }</style><b style="animation: x 10s"></b>';
        const frame = document.querySelector('iframe'), win = frame.contentWindow, open = win.closed;
        frame.remove();
        return [heard, select.selectedIndex, sr.mode, sr.host === host, host.shadowRoot, document.getAnimations().length, sr.getAnimations().length, window.closed, open, win.closed];
      })()
    JS
    expect(got).to eq([1, 0, 'closed', true, nil, 0, 1, false, false, true])
  end
end
