# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# An OffscreenCanvas's width and height are `[EnforceRange] unsigned long long`s (HTML §4.12.5.3), the engine's
# (offscreen_canvas.rs) past any u32: one wider than 2³² keeps its width, and as an image source it is one too large for
# any bitmap — bad, not one of no area (canvas_image.rs). (Chrome refuses such a size with a TypeError, its IDL's
# `unsigned long`; the spec's type is the wider one.)
RSpec.describe 'an OffscreenCanvas past 2³²' do
  include PollUntil

  it 'keeps its size, and is a source too large to draw' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.__seen = [];
      const big = new OffscreenCanvas(2 ** 32 + 1, 1);
      __seen.push(big.width, new OffscreenCanvas(2 ** 32, 1).width);
      big.width = 2 ** 32 + 3;
      __seen.push(big.width);
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      try { ctx.drawImage(new OffscreenCanvas(2 ** 32, 1), 0, 0); __seen.push('drew nothing'); } catch (e) { __seen.push(e.name); }
      createImageBitmap(big).then(() => __seen.push('resolved'), (e) => __seen.push(e.name));
    JS
    expect(poll_until { s.evaluate_script('window.__seen.length') == 5 && s.evaluate_script('window.__seen') }).to eq(
      [4_294_967_297, 4_294_967_296, 4_294_967_299, 'drew nothing', 'InvalidStateError']
    )
  end
end
