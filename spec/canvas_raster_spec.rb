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

  it 'throws a RangeError where a clip mask cannot be had, rather than abort' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (function () {
        var c = document.createElement('canvas'); c.width = c.height = 2147483647;
        var x = c.getContext('2d'); x.rect(0, 0, 1, 1);
        try { x.clip(); return 'no throw'; } catch (e) { return e.name; }
      })()
    JS
    expect(got).to eq('RangeError')
  end

  it 'draws nothing under a transform past what a double holds, and strokes a too-fine dash pattern whole' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (function () {
        var x = new OffscreenCanvas(10, 10).getContext('2d');
        x.scale(1e200, 1); x.scale(1e200, 1); x.fillRect(0, 0, 1, 1);
        var painted = Array.from(x.getImageData(0, 0, 10, 10).data).some(function (v) { return v !== 0; });
        var y = new OffscreenCanvas(100, 10).getContext('2d');
        y.setLineDash([1e-9, 1e-9]); y.beginPath(); y.moveTo(0, 5); y.lineTo(100, 5); y.stroke();
        return [painted, y.getImageData(50, 5, 1, 1).data[3] > 0];
      })()
    JS
    expect(got).to eq([false, true])
  end

  # Chrome's answers (measured): a path added to another is continued from its own last point, a copied one from the
  # point it had; a DOMPointInit radius missing a member takes it as 0; a non-finite radius before a negative one makes
  # roundRect nothing, as the spec reads them in order.
  it 'continues a path from where an added or copied one left off, and reads roundRect radii as the spec does' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (function () {
        var ctx = new OffscreenCanvas(100, 100).getContext('2d'), r = [];
        ctx.lineWidth = 2;
        var p = new Path2D(); p.moveTo(10, 10); p.lineTo(20, 10);
        var q = new Path2D(); q.moveTo(50, 50); q.lineTo(60, 50);
        p.addPath(q); p.lineTo(60, 70);
        r.push(ctx.isPointInStroke(p, 60, 60), ctx.isPointInStroke(p, 40, 40));
        var a = new Path2D(); a.moveTo(10, 10); a.lineTo(20, 10);
        var b = new Path2D(a); b.lineTo(20, 30);
        r.push(ctx.isPointInStroke(b, 20, 20));
        var rr = new Path2D(); rr.roundRect(0, 0, 10, 10, [{x: 5}]);
        r.push(ctx.isPointInPath(rr, 0.5, 0.5));
        try { new Path2D().roundRect(0, 0, 10, 10, [NaN, -1]); r.push('nothing'); } catch (e) { r.push(e.name); }
        try { new Path2D().roundRect(0, 0, 10, 10, [-1, NaN]); r.push('nothing'); } catch (e) { r.push(e.name); }
        return r;
      })()
    JS
    expect(got).to eq([true, false, true, true, 'nothing', 'RangeError'])
  end

  # Chrome's answers (measured): SVG path data in error — short of a number, a number out of range, not opening with a
  # moveto, an arc flag that is not one `0` or `1` — draws up to the segment in error and no further, and the current
  # point stays the last one drawn; a radii object whose `@@iterator` is not a method is a TypeError. A
  # Path2D's array is the page's to replace — a lying one is no current point, not a crash.
  it 'stops SVG path data at a segment short of a number, and trusts nothing in a path array the page hands over' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (function () {
        var ctx = new OffscreenCanvas(100, 100).getContext('2d'), r = [];
        var p = new Path2D('M0 0 L100 0 L100 100 L0');
        r.push(ctx.isPointInPath(p, 60, 20), ctx.isPointInPath(p, 20, 60), ctx.isPointInPath(p, 99, 98));
        var q = new Path2D('M0 0 L100 0 L50'); q.lineTo(100, 100);
        r.push(ctx.isPointInStroke(q, 100, 50));
        // (…a number out of range, a first command that is no moveto, a flag that is not one character; and flags
        // packed into one number, which is no error)
        r.push(ctx.isPointInPath(new Path2D('M0 0 L100 0 L1e400 100 L0 100 Z'), 50, 50));
        r.push(ctx.isPointInPath(new Path2D('L100 0 L100 100 L0 100 Z'), 50, 50));
        r.push(ctx.isPointInPath(new Path2D('M0 0 L100 0 A 10 10 0 2 1 100 100 L0 100 Z'), 50, 50));
        r.push(ctx.isPointInPath(new Path2D('M0 0 L100 0 A50 50 0 0150 100 Z'), 60, 40));
        try { new Path2D().roundRect(0, 0, 10, 10, {[Symbol.iterator]: 1, x: 1}); r.push('nothing'); } catch (e) { r.push(e.name); }
        var h = new Path2D(); h.moveTo(0, 0);
        h._buf = new Float64Array([8, 0, 0, 100, 0, 0, 0, 0]);
        h.lineTo(1, 1); h.closePath();
        r.push('alive');
        return r;
      })()
    JS
    expect(got).to eq([true, false, true, true, false, false, false, true, 'TypeError', 'alive'])
  end
end
