# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Two properties of the `Performance` surface that a driver can silently regress without any app
# noticing until it takes the wrong branch: the interface really extends EventTarget (its IDL says
# `interface Performance : EventTarget`, and hr-time dispatches an event at it), and
# `crossOriginIsolated` answers `false` rather than `undefined`.
#
# NOT covered here — three known gaps, each built and withdrawn today, each with its diagnosis in
# platform-globals.js: sub-millisecond `performance.now()`, Navigation Timing L1 (`timing` /
# `navigation` / `toJSON`, withdrawn as a partial API worse than its absence), and the time ORIGIN,
# which is the snapshot BUILD time rather than the navigation's.
RSpec.describe 'the Performance surface' do
  def session
    @session ||= begin
      s = simulated_session(->(_env) {
        [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
      })
      s.visit '/'
      s
    end
  end

  it 'extends EventTarget, so an event can be dispatched at it' do
    expect(session.evaluate_script(<<~JS)).to eq('isEventTarget' => true, 'handled' => true)
      (() => {
        let handled = false;
        performance.addEventListener('testEvent', () => { handled = true; }, {once: true});
        performance.dispatchEvent(new Event('testEvent'));
        return {isEventTarget: performance instanceof EventTarget, handled};
      })()
    JS
  end

  it 'defines crossOriginIsolated as false rather than leaving it undefined' do
    # `undefined` is not the same answer as `false`: two hr-time tests assert the boolean before
    # reaching what they actually test, and app code branches on it for SharedArrayBuffer.
    # …and on the window PROTOTYPE, not as an own enumerable property: Chrome keeps it off
    # `Object.keys(window)`, and an own accessor would stop a top-level classic-script `var` from
    # shadowing it — the rule platform-globals.js states for every read-only Window member.
    r = session.evaluate_script(<<~JS)
      ({
        type:   typeof crossOriginIsolated,
        value:  crossOriginIsolated,
        ownKey: Object.keys(globalThis).includes('crossOriginIsolated')
      })
    JS
    expect(r).to eq('type' => 'boolean', 'value' => false, 'ownKey' => false)
  end
end
