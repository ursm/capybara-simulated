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

  it 'constructs no Node of its own' do
    expect(session.evaluate_script('(() => { try { new Node(); } catch (e) { return e.message; } })()')).to eq("Failed to construct 'Node': Illegal constructor")
  end
end
