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
end
