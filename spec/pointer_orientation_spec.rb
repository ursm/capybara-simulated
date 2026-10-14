# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A PointerEvent's orientation (Pointer Events §4.1.3): the init's tilts or its altitude and azimuth, the other pair
# converted from them, a perpendicular pointer given neither. The figures are Chrome's, measured.
RSpec.describe 'a pointer event orientation' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8>']] }) }

  before { session.visit '/' }

  it 'converts tilts to angles and angles to tilts as Chrome does' do
    got = session.evaluate_script(<<~JS)
      [{}, {tiltX: 45, tiltY: 45}, {tiltX: 0, tiltY: -30}, {tiltX: -90}, {altitudeAngle: 0, azimuthAngle: Math.PI},
       {altitudeAngle: Math.PI / 4, azimuthAngle: 1}, {altitudeAngle: 1.5, azimuthAngle: 3.5}, {tiltX: 10, altitudeAngle: 1}]
        .map((i) => { const e = new PointerEvent('pointerdown', i); return [e.tiltX, e.tiltY, +e.altitudeAngle.toFixed(10), +e.azimuthAngle.toFixed(10)]; })
    JS
    expect(got).to eq([
      [0, 0, 1.5707963268, 0],
      [45, 45, 0.6154797087, 0.7853981634],
      [0, -30, 1.0471975512, 4.7123889804],
      [-90, 0, 0, 3.1415926536],
      [-90, 0, 0, 3.1415926536],
      [28, 40, 0.7853981634, 1],
      [-4, -1, 1.5, 3.5],
      [10, 0, 1, 0]
    ])
  end
end
