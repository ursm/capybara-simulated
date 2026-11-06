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

  # The settings are the context's for good: a resize and `reset()` put back its bitmap and its drawing state, nothing
  # of what getContext was given (HTML "set bitmap dimensions" / "reset the rendering context to its default state").
  # Each getContextAttributes() answers a new dictionary, whose members are the page's to change.
  it 'keeps its settings through a resize and a reset' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const settings = {alpha: false, colorSpace: 'display-p3', desynchronized: true, willReadFrequently: true};
        const expected = (ctx) => JSON.stringify(ctx.getContextAttributes());
        const ctx = document.createElement('canvas').getContext('2d', settings);
        const off = new OffscreenCanvas(4, 4).getContext('2d', settings);
        const before = expected(ctx);
        ctx.fillStyle = 'red';
        ctx.canvas.width = 4;
        const resized = [expected(ctx), ctx.fillStyle, ctx.getImageData(0, 0, 1, 1).colorSpace];
        ctx.reset();
        off.canvas.height = 2;
        const first = ctx.getContextAttributes();
        first.colorSpace = 'srgb';
        return [before, resized, expected(ctx), expected(off), ctx.getImageData(0, 0, 1, 1).colorSpace, off.getImageData(0, 0, 1, 1).colorSpace];
      })()
    JS
    attributes = '{"alpha":false,"colorSpace":"display-p3","colorType":"unorm8","desynchronized":true,"willReadFrequently":true}'
    expect(got).to eq([attributes, [attributes, '#000000', 'display-p3'], attributes, attributes, 'display-p3', 'display-p3'])
  end

  # The context keeps its bitmap's size as HTML's "set bitmap dimensions" sets it: whichever way a `width` or a `height`
  # attribute changed, a draw covers the new size and no more, a canvas of no area draws nothing, and a resize leaves the
  # bitmap transparent black and the drawing state its default.
  it 'draws into the size its canvas was last given' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const covered = (c, w, h) => {
          c.fillRect(0, 0, 1000, 1000);
          const data = c.getImageData(0, 0, w + 1, h + 1).data;
          return [data[(w - 1) * 4 + 3], data[w * 4 + 3], data[((w + 1) * (h - 1)) * 4 + 3], data[((w + 1) * h) * 4 + 3]];
        };
        const blank = (c) => c.getImageData(0, 0, 1, 1).data[3];
        const out = [covered(ctx, 300, 150)];
        canvas.width = 4;
        out.push(blank(ctx), covered(ctx, 4, 150));
        canvas.setAttribute('height', '3');
        out.push(blank(ctx), covered(ctx, 4, 3));
        canvas.removeAttribute('width');
        out.push(blank(ctx), covered(ctx, 300, 3));
        canvas.setAttributeNS(null, 'width', '2');
        out.push(covered(ctx, 2, 3));
        const attr = canvas.getAttributeNode('width');
        attr.value = '5';
        out.push(covered(ctx, 5, 3));
        canvas.width = 0;
        ctx.fillRect(0, 0, 10, 10);
        ctx.fillStyle = 'red';
        out.push(ctx.getImageData(0, 0, 1, 1).data[3]);
        canvas.width = 2;
        out.push(ctx.fillStyle, blank(ctx));

        const off = new OffscreenCanvas(2, 2), g = off.getContext('2d');
        out.push(covered(g, 2, 2));
        off.width = 3;
        out.push(blank(g), covered(g, 3, 2));
        const before = off.transferToImageBitmap();
        out.push(blank(g), covered(g, 3, 2));
        const copy = new OffscreenCanvas(3, 2), h = copy.getContext('2d');
        h.drawImage(before, 0, 0);
        out.push(h.getImageData(2, 1, 1, 1).data[3]);
        return out;
      })()
    JS
    expect(got).to eq([
      [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      [255, 0, 255, 0],
      [255, 0, 255, 0],
      0, '#000000', 0,
      [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      255
    ])
  end

  # fillRect, clearRect and strokeRect return early on an argument that is not finite, the first two on no area and
  # strokeRect on neither a width nor a height (which, with just one, strokes the line it is) — and, returning, do not
  # disturb a whole-canvas operator's destination, which a draw of no coverage would clear.
  it 'keeps the early returns of its rectangle operations' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        const painted = (draw) => {
          ctx.reset();
          ctx.fillRect(0, 0, 10, 10);
          ctx.globalCompositeOperation = 'copy';
          ctx.fillStyle = ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
          draw();
          return ctx.getImageData(5, 5, 1, 1).data[3];
        };
        return [
          painted(() => ctx.fillRect(0, 0, 0, 5)),
          painted(() => ctx.fillRect(NaN, 0, 5, 5)),
          painted(() => ctx.clearRect(0, 0, 5, 0)),
          painted(() => ctx.clearRect(0, Infinity, 5, 5)),
          painted(() => ctx.strokeRect(0, 0, 0, 0)),
          painted(() => ctx.strokeRect(0, 0, -Infinity, 5)),
          painted(() => ctx.fillRect(20, 20, 1, 1)),
          painted(() => ctx.strokeRect(20, 20, 0, 5))
        ];
      })()
    JS
    expect(got).to eq([255, 255, 255, 255, 255, 255, 0, 0])
  end
end
