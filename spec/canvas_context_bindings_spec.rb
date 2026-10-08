# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D, generated from their IDL: made by a canvas alone,
# their engine in their slots, their overloads resolved and their arguments converted by the binding.
RSpec.describe 'Canvas context bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']] })
    s.visit('/')
    s
  }

  def error(js) = "(() => { try { #{js}; return 'none'; } catch (e) { return e.name; } })()"

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const off = new OffscreenCanvas(1, 1).getContext('2d');
        return [
          [Object.prototype.toString.call(ctx), Object.keys(ctx), ctx.canvas === canvas, canvas.getContext('2d') === ctx],
          [Object.prototype.toString.call(off), off instanceof OffscreenCanvasRenderingContext2D, off instanceof CanvasRenderingContext2D,
           'drawFocusIfNeeded' in off, off.canvas instanceof OffscreenCanvas],
          #{error('new CanvasRenderingContext2D()')},
          #{error('new OffscreenCanvasRenderingContext2D()')},
          #{error("Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'lineWidth').get.call(off)")},
          #{error('CanvasRenderingContext2D.prototype.fillRect.call({}, 0, 0, 1, 1)')}
        ];
      })()
    JS
    expect(got).to eq([
      ['[object CanvasRenderingContext2D]', [], true, true],
      ['[object OffscreenCanvasRenderingContext2D]', true, false, false, true],
      'TypeError', 'TypeError', 'TypeError', 'TypeError'
    ])
  end

  # Web IDL's overload resolution: a Path2D by its slots (a forged one, a plain object or null is none), a count only the
  # path's form takes the path's, a CanvasFillRule an enumeration (Chrome: TypeError for every one of these).
  it 'resolves its overloads as Web IDL does' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        const forged = Object.create(Path2D.prototype);
        return [
          #{error('ctx.fill({})')},
          #{error('ctx.fill(forged)')},
          #{error('ctx.fill(null)')},
          #{error("ctx.fill({}, 'nonzero')")},
          #{error("ctx.fill('bogus')")},
          #{error("ctx.fill(new Path2D(), 'bogus')")},
          #{error('ctx.stroke({})')},
          #{error('ctx.stroke(null)')},
          #{error('ctx.clip(forged)')},
          #{error('ctx.isPointInStroke(forged, 10, 12)')},
          #{error('ctx.setTransform(1, 2)')},
          #{error('ctx.drawImage(ctx.canvas, 0)')},
          #{error("ctx.fill('evenodd')")},
          #{error('ctx.fill(new Path2D())')},
          #{error('ctx.setTransform()')}
        ];
      })()
    JS
    expect(got).to eq(%w[TypeError] * 12 + %w[none none none])
  end

  # An image source is one by its slots — a forged OffscreenCanvas or ImageBitmap none (Chrome: TypeError) — and a
  # canvas source is never asked for its context through the page's `getContext` (Chrome: not called), which would
  # make one with default settings; getContextAttributes' dictionary has its members in their name's order.
  it 'takes its image sources by what they are' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        const source = document.createElement('canvas');
        let asked = 0;
        const own = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (...args) { asked++; return own.apply(this, args); };
        ctx.drawImage(source, 0, 0);
        ctx.createPattern(source, 'repeat');
        HTMLCanvasElement.prototype.getContext = own;
        const later = source.getContext('2d', {alpha: false});
        return [
          #{error('ctx.drawImage(Object.create(OffscreenCanvas.prototype), 0, 0)')},
          #{error('ctx.drawImage(Object.create(ImageBitmap.prototype), 0, 0)')},
          #{error("ctx.createPattern(Object.create(OffscreenCanvas.prototype), 'repeat')")},
          asked, later.getContextAttributes().alpha,
          Object.keys(ctx.getContextAttributes())
        ];
      })()
    JS
    expect(got).to eq([
      'TypeError', 'TypeError', 'TypeError', 0, false,
      %w[alpha colorSpace colorType desynchronized willReadFrequently]
    ])
  end
end
