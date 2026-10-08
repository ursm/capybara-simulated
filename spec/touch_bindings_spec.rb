# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Touch, TouchList and TouchEvent, generated from their IDL. The figures are headless Chrome's, but where the IDL has
# what Chrome has not: a Touch's touchType / altitudeAngle / azimuthAngle, and TouchEvent's getModifierState.
RSpec.describe 'Touch bindings' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const touch = new Touch({identifier: 1, target: document.body, clientX: 5, force: 0.5});
        const event = new TouchEvent('touchstart', {touches: [touch], ctrlKey: true});
        return [
          [typeof Touch, typeof TouchList, typeof TouchEvent, 'ontouchstart' in window],
          error(() => new Touch()),
          error(() => new Touch({identifier: 1})),
          [touch.identifier, touch.target === document.body, touch.clientX, touch.pageX, touch.force, touch.touchType, touch.radiusX, touch.altitudeAngle],
          [event.touches.length, event.touches[0] === touch, event.touches.item(0) === touch, event.touches.item(5),
           event.targetTouches.length, event.ctrlKey, event.getModifierState('Control'),
           Object.prototype.toString.call(event.touches), event.touches === event.touches],
          error(() => new TouchEvent('x', {touches: [{}]})),
          error(() => new TouchList())
        ];
      })()
    JS
    expect(got).to eq([
      %w[function function function] + [false],
      "TypeError: Failed to construct 'Touch': 1 argument required, but only 0 present.",
      "TypeError: Failed to construct 'Touch': Failed to read the 'target' property from 'TouchInit': Required member is undefined.",
      [1, true, 5, 0, 0.5, 'direct', 0, 0],
      [1, true, true, nil, 0, true, true, '[object TouchList]', true],
      "TypeError: Failed to construct 'TouchEvent': Failed to read the 'touches' property from 'TouchEventInit': Failed to convert value to 'Touch'.",
      "TypeError: Failed to construct 'TouchList': Illegal constructor"
    ])
  end
end
