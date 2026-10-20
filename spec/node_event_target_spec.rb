# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A Node is an EventTarget (DOM §4.4): `Node` extends `EventTarget`, and a node's listeners are added, removed and
# dispatched to by EventTarget's own members — one implementation, which takes an AbortSignal (a node's own copy of the
# members had ignored `signal`, so an aborted listener kept firing). Each expectation is Chrome's (154.0.8037.92).
RSpec.describe 'Node as an EventTarget' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/' }

  it 'inherits from EventTarget, and uses its members' do
    got = session.evaluate_script(<<~JS)
      [
        Object.getPrototypeOf(Node) === EventTarget,
        Object.getPrototypeOf(Node.prototype) === EventTarget.prototype,
        document.createTextNode('') instanceof EventTarget,
        document.body.addEventListener === EventTarget.prototype.addEventListener,
        document.dispatchEvent === EventTarget.prototype.dispatchEvent
      ]
    JS
    expect(got).to eq([true, true, true, true, true])
  end

  it "removes a node's listener when its signal aborts, and refuses a signal that is no AbortSignal" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div');
        let n = 0;
        const ac = new AbortController();
        d.addEventListener('x', () => n++, {signal: ac.signal});
        d.dispatchEvent(new Event('x'));
        ac.abort();
        d.dispatchEvent(new Event('x'));
        let refused;
        try { d.addEventListener('y', () => {}, {signal: null}); } catch (e) { refused = e.constructor.name; }
        return [n, refused];
      })()
    JS
    expect(got).to eq([1, 'TypeError'])
  end

  it "dispatches over a node's tree, through EventTarget's dispatchEvent" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const p = document.createElement('p'), c = p.appendChild(document.createElement('i'));
        let got = '';
        p.addEventListener('z', (e) => { got = e.target.tagName + ' ' + e.eventPhase; });
        EventTarget.prototype.dispatchEvent.call(c, new Event('z', {bubbles: true}));
        return got;
      })()
    JS
    expect(got).to eq('I 3')
  end

  # (…a node reached later in the path is asked for its listeners as the dispatch reaches it: one no listener had been on,
  # given one by a listener — of a type a node had, or of one none had — fires all the same; Chrome 155.0.8059.39)
  it 'fires a listener added during the dispatch to a node it has yet to reach' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const a = document.body.appendChild(document.createElement('div'));
        const b = a.appendChild(document.createElement('div')), c = b.appendChild(document.createElement('div'));
        const log = [];
        c.addEventListener('zz', () => { log.push('c'); a.addEventListener('zz', () => log.push('a-late')); });
        c.dispatchEvent(new Event('zz', {bubbles: true}));
        c.addEventListener('q1', () => {
          b.addEventListener('q1', () => log.push('b-late-capture'), true);
          a.addEventListener('q1', () => log.push('a-bubble'));
        });
        c.dispatchEvent(new Event('q1', {bubbles: true}));
        return log.join(',');
      })()
    JS
    expect(got).to eq('c,a-late,a-bubble')
  end

  # (…and which realm's script added a listener is no matter: a node adopted from a frame keeps the frame's, and a frame
  # node given one by this realm's addEventListener fires it on the frame's dispatch)
  it "fires a listener another realm's script added" do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.body.appendChild(document.createElement('iframe'));
      f.onload = () => {
        const log = [], fd = f.contentDocument;
        const el = fd.createElement('div');
        el.addEventListener('xa', () => log.push('adopted'));
        const child = el.appendChild(document.createElement('span'));
        document.body.appendChild(el);
        child.dispatchEvent(new Event('xa', {bubbles: true}));
        EventTarget.prototype.addEventListener.call(fd.body, 'xb', () => log.push('frame-body'));
        fd.body.appendChild(fd.createElement('i')).dispatchEvent(new f.contentWindow.Event('xb', {bubbles: true}));
        done(log.join(','));
      };
      f.srcdoc = '<!doctype html><body>';
    JS
    expect(got).to eq('adopted,frame-body')
  end

  # DOM "dispatch" invokes a target's event listeners, and an event handler is one only where an IDL attribute made it
  # (HTML §8.1.8): an `on<type>` method of an EventTarget subclass is no handler, and a dispatched `<type>` does not call
  # it; an interface's handler attribute (an AbortSignal's `onabort`) still is one.
  it "calls no method an EventTarget subclass names on<type>" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const log = [];
        class Pinger extends EventTarget { onping() { log.push('method'); } }
        const t = new Pinger();
        t.addEventListener('ping', () => log.push('listener'));
        t.dispatchEvent(new Event('ping'));
        const plain = new EventTarget();
        plain.onping = () => log.push('field');
        plain.dispatchEvent(new Event('ping'));
        const c = new AbortController();
        c.signal.onabort = () => log.push('onabort');
        c.abort();
        return log;
      })()
    JS
    expect(got).to eq(%w[listener onabort])
  end

  it 'constructs no Node of its own' do
    expect(session.evaluate_script('(() => { try { new Node(); } catch (e) { return e.message; } })()')).to eq("Failed to construct 'Node': Illegal constructor")
  end
end

# DOM "inner invoke" sets `window.event` on the LISTENER's global (its relevant realm's), not the dispatch's: a
# listener from another realm on a node reads the event off its own `window.event`, but one on a node inside a shadow
# tree finds its global's left as it was (step 8). An object listener's realm is the object's, whatever realm its
# `handleEvent` comes from. event-global-extra.window.js.
RSpec.describe "A node listener's window.event" do
  let(:session) {
    simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=host></div><iframe srcdoc="<p>"></iframe>']]
    })
  }

  before { session.visit '/' }

  it "is the event on the listener's own realm, and left alone for one in a shadow tree" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const f = frames[0];
        const seen = [];
        const record = f.eval('(seen) => function (e) { seen.push(window.event === e ? "event" : String(window.event)); }');
        const host = document.getElementById('host');
        const inner = host.attachShadow({mode: 'open'}).appendChild(document.createElement('span'));
        host.addEventListener('x', record(seen));
        inner.addEventListener('x', record(seen));
        host.addEventListener('x', {handleEvent: record(seen)});
        inner.dispatchEvent(new Event('x', {bubbles: true, composed: true}));
        return [seen, f.event === undefined, window.event === undefined];
      })()
    JS
    expect(got).to eq([%w[undefined event undefined], true, true])
  end

  it 'is hidden from a listener of a node that was in a shadow tree as the dispatch began, wherever it is moved' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const host = document.getElementById('host');
        const child = host.attachShadow({mode: 'open'}).appendChild(document.createElement('i'));
        const inner = child.appendChild(document.createElement('b'));
        const seen = [];
        const look = (e) => seen.push(window.event === e ? 'event' : String(window.event));
        inner.addEventListener('x', (e) => { host.appendChild(child); look(e); });
        inner.addEventListener('x', look);
        child.addEventListener('x', look);
        host.addEventListener('x', look);
        inner.dispatchEvent(new Event('x', {bubbles: true, composed: true}));
        return seen;
      })()
    JS
    expect(got).to eq(%w[undefined undefined undefined event])
  end

  it "follows a slotted node's path into the shadow tree and out of it" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const host = document.getElementById('host');
        const slot = host.attachShadow({mode: 'open'}).appendChild(document.createElement('slot'));
        const child = host.appendChild(document.createElement('b'));
        const seen = [];
        const look = (name) => (e) => seen.push(name + ':' + (window.event === e ? 'event' : String(window.event)));
        child.addEventListener('x', look('child'));
        slot.addEventListener('x', look('slot'));
        slot.parentNode.addEventListener('x', look('root'));
        host.addEventListener('x', look('host'));
        child.dispatchEvent(new Event('x', {bubbles: true}));
        return seen;
      })()
    JS
    expect(got).to eq(%w[child:event slot:undefined root:undefined host:event])
  end
end
