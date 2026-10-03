# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A canvas's text drawing state as the style engine reads it (cssom_decl.rs `canvas_font`, `canvas_spacing`): `font`
# computed at assignment, and `letterSpacing` / `wordSpacing` parsed as a CSS <length> and read back serialized (HTML
# §4.12.5.1.11, "the serialized form of the current letter spacing") — `1.50PX` reads `1.5px`, as Chrome has it. Two
# answers are the spec's over Chrome's: a unitless `0` and a `calc()` ARE <length>s (CSS Values 4 §6.2, §10), which
# Chrome ignores.
RSpec.describe 'canvas text state' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>x</body>']] } }

  def run(js)
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script("(function () { var x = new OffscreenCanvas(10, 10).getContext('2d'); #{js} })()")
  end

  it 'reads a spacing back serialized, and ignores what is no length' do
    got = run(<<~JS)
      return ['1.50PX', '0', 'calc(1px + 2px)', '1E1px', '-2em', '10%', 'normal'].map(function (v) {
        x.letterSpacing = '7px'; x.letterSpacing = v; return x.letterSpacing;
      });
    JS
    expect(got).to eq(%w[1.5px 0px calc(3px) 10px -2em 7px 7px])
  end

  it 'resolves a font-relative spacing against the current font' do
    got = run(<<~JS)
      x.font = '20px monospace';
      var w = x.measureText('abcd').width;
      x.letterSpacing = '0.5em';
      return x.measureText('abcd').width - w;
    JS
    expect(got).to eq(40)                                                       # 10px after each of 4 characters
  end

  it 'computes the font at assignment' do
    got = run(<<~JS)
      var out = [];
      ['600 12px "My Font", serif', 'italic small-caps bold 2em/3 a', 'caption', '12px inherit'].forEach(function (v) { x.font = v; out.push(x.font); });
      return out;
    JS
    expect(got).to eq(['600 12px "My Font", serif', 'italic small-caps bold 20px a', '16px sans-serif', '16px sans-serif'])
  end
end
