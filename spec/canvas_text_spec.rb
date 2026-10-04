# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A canvas's text shaped and measured natively (csim_native's text.rs): HarfBuzz's shaping in the face the family
# resolves to, kerned unless `fontKerning` says none, put in visual order by the bidirectional algorithm on the
# canvas's direction. Each figure is Chrome's on this machine (measured), Arial resolving to Liberation Sans.
RSpec.describe 'canvas text' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] } }

  it 'measures a line as Chrome does' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = '16px Arial';
        const m = c.measureText('Hello, Wgjy');
        const kerned = c.measureText('AVAVAV').width;
        c.fontKerning = 'none';
        const plain = c.measureText('AVAVAV').width;
        return [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent,
                m.fontBoundingBoxAscent, m.fontBoundingBoxDescent, m.hangingBaseline, m.ideographicBaseline, kerned, plain,
                c.measureText('\\0').width];
      })()
    JS
    expect(got[0..8]).to eq([80.90625, -1, 80.90625, 12, 3, 14, 3, 11.200000000000001, -3])
    expect(got[9..]).to eq([58.09375, 64.03125, 0])
  end

  # The bidirectional algorithm on the canvas's direction: a right-to-left line of Latin text keeps its letters in
  # order and moves its trailing `!` to the left — `Hi!` drawn right-to-left is `!Hi` drawn left-to-right, pixel for
  # pixel, as Chrome draws it.
  it 'puts a line in visual order on its direction' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const draw = (text, dir) => {
          const c = document.createElement('canvas');
          c.width = 120; c.height = 30;
          const g = c.getContext('2d');
          g.font = '16px Arial'; g.direction = dir; g.textAlign = 'left';
          g.fillText(text, 10, 20);
          return Array.from(g.getImageData(0, 0, 120, 30).data).join(',');
        };
        return [draw('Hi!', 'rtl') === draw('!Hi', 'ltr'), draw('Hi!', 'rtl') === draw('Hi!', 'ltr')];
      })()
    JS
    expect(got).to eq([true, false])
  end
end
