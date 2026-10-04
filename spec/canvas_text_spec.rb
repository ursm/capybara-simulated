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

  # A face in a collection (`.ttc`, as the Noto CJK faces ship): read at the index fontconfig names, so each family is
  # its own member — 直 differs between the Japanese and the Simplified Chinese one — and a character the line's face
  # lacks falls back to one, not to a `.notdef` box. Chrome: 71.99977 wide, a 28 / 7 font box (22 / 5 for
  # sans-serif, whose primary face is Liberation Sans), 46951 and 50558 of ink.
  it 'sets text in a face of a font collection' do
    face, = Capybara::Simulated::Native.font_match('Noto Sans CJK SC')
    skip 'no Noto Sans CJK collection installed' unless face&.include?("\0")
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = document.createElement('canvas').getContext('2d');
        const metrics = ['24px "Noto Sans CJK JP"', '24px sans-serif'].map((f) => {
          c.font = f;
          const m = c.measureText('日本直');
          return [m.width, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent];
        });
        const ink = (f) => {
          const x = Object.assign(document.createElement('canvas'), {width: 40, height: 40}).getContext('2d');
          x.font = f;
          x.fillText('直', 4, 30);
          return x.getImageData(0, 0, 40, 40).data.filter((_, i) => i % 4 === 3).reduce((a, b) => a + b, 0);
        };
        return [metrics, ink('24px "Noto Sans CJK JP"'), ink('24px "Noto Sans CJK SC"')];
      })()
    JS
    expect(got[0]).to eq([[72, 28, 7], [72, 22, 5]])
    # (…the outlines unhinted, the ink a little off Chrome's; the two members' glyphs apart all the same)
    expect(got[1]).to be_within(2000).of(46_951)
    expect(got[2]).to be_within(2000).of(50_558)
    expect(got[2] - got[1]).to be > 2000
  end

  # Only what can reach the canvas is rasterized: a line half off it draws the pixels the same line draws on a canvas
  # wide enough to hold it — condensed by maxWidth, aligned, and through a shadow that brings off-canvas ink on — and a
  # glyph at 100000px costs the canvas it covers, not the gigabytes its whole mask would.
  it 'draws only the part of a line that reaches the canvas' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const draw = (width, dx) => {
          const c = Object.assign(document.createElement('canvas'), {width, height: 60}).getContext('2d');
          c.font = '30px serif';
          c.fillText('Condensed text', dx - 40, 25, 90);
          c.textAlign = 'center';
          c.shadowColor = 'red';
          c.shadowOffsetX = 120;
          c.fillText('Hg', dx - 100, 55);
          return Array.from(c.getImageData(width - 100, 0, 100, 60).data);
        };
        const big = Object.assign(document.createElement('canvas'), {width: 50, height: 50}).getContext('2d');
        big.font = '100000px serif';
        big.fillText('I', -20000, 50000);
        const ink = big.getImageData(0, 0, 50, 50).data.filter((_, i) => i % 4 === 3).reduce((a, b) => a + b, 0);
        return [draw(100, 0).join() === draw(300, 200).join(), draw(100, 0).some((v) => v > 0), ink];
      })()
    JS
    expect(got[0..1]).to eq([true, true])
    expect(got[2]).to eq(50 * 50 * 255)                                   # inside the stem of the I
  end

  # A blurred shadow reaches past the ink by the blur: a glyph whose ink ends 3px left of the canvas still blurs its
  # shadow onto it. Chrome: 6275 of alpha in the first ten columns (the blur here three box passes, a little off it).
  it 'blurs the shadow of ink just off the canvas onto it' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = Object.assign(document.createElement('canvas'), {width: 100, height: 60}).getContext('2d');
        g.font = '40px sans-serif';
        g.shadowColor = 'red';
        g.shadowBlur = 20;
        g.fillText('I', -g.measureText('I').actualBoundingBoxRight - 3, 45);
        return g.getImageData(0, 0, 10, 60).data.filter((_, i) => i % 4 === 3).reduce((a, b) => a + b, 0);
      })()
    JS
    expect(got).to be_within(600).of(6275)
  end
end
