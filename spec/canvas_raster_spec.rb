# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'

# What the 2D canvas's drawing operations leave in the bitmap (canvas.rs, canvas_path.rs): an anti-aliased box edge,
# an even-odd path, linear / radial / conic gradients, a transformed pattern, drawImage smoothed and nearest, a shadow,
# the compositing operators, a clip, clearRect, a dashed stroke, Display P3; and the paths — SVG path data, arcTo,
# roundRect, a dashed transformed ellipse, addPath, isPointInPath / isPointInStroke. Each held to the figures the
# rasterizer gave when it was ported to Rust, which matched the JS one it replaced to the byte.
RSpec.describe 'canvas rasterizer' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>x</body>']] } }
  let(:fixtures) { File.join(__dir__, 'fixtures/canvas_raster') }

  {'probe' => 'expected', 'paths' => 'paths'}.each do |probe, figures|
    it "paints every operation of #{probe}.js to the recorded figures" do
      s = simulated_session(app)
      s.visit '/'
      got = JSON.parse(s.evaluate_script(File.read(File.join(fixtures, "#{probe}.js"))))
      JSON.parse(File.read(File.join(fixtures, "#{figures}.json"))).each do |name, pixels|
        expect(got[name]).to eq(pixels), "#{name} differs"
      end
    end
  end

  it 'draws nothing of a smoothed source rectangle that lies wholly off the image' do
    s = simulated_session(app)
    s.visit '/'
    px = s.evaluate_script(<<~JS)
      (function () {
        var src = new OffscreenCanvas(2, 2); src.getContext('2d').fillRect(0, 0, 2, 2);
        var c = new OffscreenCanvas(4, 4), x = c.getContext('2d');
        x.fillStyle = 'gray'; x.fillRect(0, 0, 4, 4);
        x.drawImage(src, 5, 5, 2, 2, 0, 0, 4, 4);
        return Array.from(x.getImageData(1, 1, 1, 1).data);
      })()
    JS
    expect(px).to eq([128, 128, 128, 255])
  end

  it 'clears what fillText does not cover under a whole-canvas operator' do
    s = simulated_session(app)
    s.visit '/'
    corner = s.evaluate_script(<<~JS)
      (function () {
        var c = new OffscreenCanvas(40, 20), x = c.getContext('2d');
        x.fillStyle = 'gray'; x.fillRect(0, 0, 40, 20);
        x.globalCompositeOperation = 'copy'; x.fillStyle = 'black'; x.font = '16px sans-serif'; x.fillText('i', 2, 15);
        return Array.from(x.getImageData(39, 19, 1, 1).data);
      })()
    JS
    expect(corner).to eq([0, 0, 0, 0])                                          # `copy` leaves nothing it did not draw
  end
end
