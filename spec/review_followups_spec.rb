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

  # …and a second round: composedPath() ends where the window phase goes; a frame navigated keeps its window open while
  # a removed one's document has none; a cloned document is inert; a select resets where an option leaves, before
  # what replaces it arrives; textContent makes its Text itself.
  it 'answers the second round as Chrome does' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const paths = [];
        const listen = (target, init) => {
          target.addEventListener('zz', (e) => paths.push(e.composedPath().length), {once: true});
          target.dispatchEvent(new Event('zz', Object.assign({bubbles: true}, init)));
        };
        listen(document.implementation.createHTMLDocument('').body);
        listen(document.body);
        const clone = document.cloneNode(true);
        const box = document.body.appendChild(document.createElement('div'));
        box.innerHTML = '<select><optgroup><option>a</option><option selected>b</option></optgroup><option>c</option></select>';
        const select = box.firstChild;
        select.firstChild.replaceChildren(new Option('n'));
        const replaced = [select.selectedIndex, select.value];
        const made = document.createTextNode;
        let calls = 0;
        document.createTextNode = function (t) { calls++; return made.call(this, t); };
        box.textContent = 'text';
        document.createTextNode = made;
        const frame = document.querySelector('iframe'), fd = frame.contentDocument;
        frame.remove();
        return [paths, clone.defaultView, clone.location, ...replaced, calls, fd.defaultView];
      })()
    JS
    expect(got).to eq([[3, 4], nil, nil, 1, 'c', 0, nil])
  end

  # A frame that navigates keeps its browsing context: the window it had is not `closed` (Chrome).
  it 'keeps a navigated frame open' do
    session.execute_script("window.__w = document.querySelector('iframe').contentWindow; document.querySelector('iframe').srcdoc = '<p>y'")
    sleep 0.1 until session.evaluate_script("document.querySelector('iframe').contentDocument.body.textContent") == 'y'
    expect(session.evaluate_script('__w.closed')).to be(false)
  end

  # A replacement goes in before what followed the node it replaces, whatever the removal's steps (a frame's unload) did
  # to the children meanwhile; a document with no browsing context — a removed frame's, a clone — has no location, no
  # domain, no focus, and is hidden.
  it 'replaces before what followed, and keeps a document with no browsing context out of the page' do
    session.execute_script(<<~JS)
      const q = document.body.appendChild(document.createElement('div'));
      q.id = 'q';
      q.innerHTML = '<i>a</i><div><iframe srcdoc="<p>q"></iframe></div><b>b</b>';
    JS
    sleep 0.1 until session.evaluate_script("document.querySelector('#q iframe').contentDocument.body.textContent") == 'q'
    got = session.evaluate_script(<<~JS)
      (() => {
        const q = document.getElementById('q'), frame = q.querySelector('iframe'), fd = frame.contentDocument;
        frame.contentWindow.addEventListener('unload', () => q.firstChild.remove());
        q.children[1].outerHTML = '<s></s><s></s>';
        const clone = document.cloneNode(true);
        return [[...q.children].map((c) => c.localName).join(), fd.location, fd.hasFocus(), clone.domain, clone.visibilityState, clone.hidden];
      })()
    JS
    expect(got).to eq(['s,s,b', nil, false, '', 'hidden', true])
  end
end
