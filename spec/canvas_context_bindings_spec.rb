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
        attr.nodeValue = '6';
        out.push(covered(ctx, 6, 3));
        canvas.removeAttributeNode(attr);
        out.push(blank(ctx), covered(ctx, 300, 3));
        canvas.setAttributeNode(attr);
        out.push(blank(ctx), covered(ctx, 6, 3));
        canvas.attributes.removeNamedItem('width');
        out.push(blank(ctx), covered(ctx, 300, 3));
        canvas.attributes.setNamedItem(attr);
        out.push(blank(ctx), covered(ctx, 6, 3));
        canvas.toggleAttribute('width');
        out.push(blank(ctx), covered(ctx, 300, 3));
        canvas.width = 7;
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
      [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
      0, [255, 0, 255, 0],
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

  # A canvas of another realm is a source like any: its size, its bitmap and its colour space are its context's, drawn
  # with the arena's reads whichever realm's bindings ask; and its own context made a canvas of the first realm's a source.
  it 'takes a canvas of another realm as a source' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const frame = document.body.appendChild(document.createElement('iframe'));
        const other = frame.contentDocument.createElement('canvas');
        other.width = other.height = 2;
        const theirs = other.getContext('2d', {colorSpace: 'display-p3'});
        theirs.fillStyle = 'rgb(255, 0, 0)';
        theirs.fillRect(0, 0, 1, 2);

        const ctx = document.createElement('canvas').getContext('2d');
        ctx.drawImage(other, 0, 0);
        const drawn = [...ctx.getImageData(0, 0, 1, 1).data, ctx.getImageData(1, 0, 1, 1).data[3], ctx.getImageData(2, 0, 1, 1).data[3]];
        const tiled = document.createElement('canvas').getContext('2d');
        tiled.fillStyle = tiled.createPattern(other, 'repeat');
        theirs.clearRect(0, 0, 2, 2);
        tiled.fillRect(0, 0, 2, 2);

        const mine = document.createElement('canvas');
        mine.width = mine.height = 1;
        mine.getContext('2d').fillRect(0, 0, 1, 1);
        theirs.drawImage(mine, 0, 0, 2, 2);
        const blank = document.createElement('canvas').getContext('2d');
        blank.drawImage(frame.contentDocument.createElement('canvas'), 0, 0);
        return [drawn, tiled.getImageData(0, 0, 1, 1).data[3], tiled.getImageData(1, 0, 1, 1).data[3], theirs.getImageData(1, 1, 1, 1).data[3], blank.getImageData(0, 0, 1, 1).data[3]];
      })()
    JS
    expect(got).to eq([[255, 0, 0, 255, 0, 0], 255, 0, 255, 0])
  end

  # getImageData and putImageData: a negative extent moves the rectangle, what falls outside the bitmap is transparent
  # black or left alone, the dirty rectangle clips to the ImageData and lands at (dx + dirtyX, dy + dirtyY), a float16
  # ImageData's components and a linear one's colour space are converted on the way in, and the array it was given is
  # left as it was.
  it 'reads and writes the rectangles HTML says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.canvas.width = ctx.canvas.height = 4;
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(1, 1, 1, 1);
        const alpha = (d) => [...d.data].filter((_, i) => i % 4 === 3);
        const out = [
          alpha(ctx.getImageData(2, 2, -2, -2)),
          alpha(ctx.getImageData(-1, 1, 3, 1)),
          [ctx.getImageData(2, 2, -2, -2).width, ctx.getImageData(2, 2, -2, -1).height],
          alpha(ctx.getImageData(3, 3, 3, 1))
        ];

        ctx.reset();
        const opaque = new ImageData(new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2);
        ctx.putImageData(opaque, 1, 1, 1, 1, -1, -1);
        out.push(alpha(ctx.getImageData(0, 0, 4, 4)));
        ctx.reset();
        ctx.putImageData(opaque, 1, 1, -5, -5, 7, 7);
        out.push(alpha(ctx.getImageData(0, 0, 4, 4)));
        ctx.reset();
        ctx.putImageData(opaque, 3, 3);
        ctx.putImageData(opaque, -1, -1);
        out.push(alpha(ctx.getImageData(0, 0, 4, 4)));
        ctx.reset();
        ctx.putImageData(opaque, 0, 0, 5, 5, 1, 1);
        ctx.putImageData(opaque, 0, 0, 0, 0, 0, 1);
        out.push(alpha(ctx.getImageData(0, 0, 4, 4)));

        ctx.reset();
        const half = new Float16Array([0.5, 0, 0, 1]);
        ctx.putImageData(new ImageData(half, 1, 1, {pixelFormat: 'rgba-float16'}), 0, 0);
        out.push([...ctx.getImageData(0, 0, 1, 1).data]);
        const linear = new ImageData(new Uint8ClampedArray([128, 0, 0, 255]), 1, 1, {colorSpace: 'srgb-linear'});
        ctx.putImageData(linear, 1, 0);
        out.push([...ctx.getImageData(1, 0, 1, 1).data], [...linear.data]);
        const back = ctx.getImageData(0, 0, 1, 1, {pixelFormat: 'rgba-float16'});
        out.push([back.data.constructor.name, back.pixelFormat, back.data[3]]);

        const gone = new ImageData(1, 1);
        structuredClone(gone.data.buffer, {transfer: [gone.data.buffer]});
        out.push(#{error('ctx.putImageData(gone, 0, 0)')});
        return out;
      })()
    JS
    expect(got).to eq([
      [0, 0, 0, 255],
      [0, 0, 255],
      [2, 1],
      [0, 0, 0],
      [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0],
      [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255],
      [0] * 16,
      [128, 0, 0, 255],
      [188, 0, 0, 255], [128, 0, 0, 255],
      ['Float16Array', 'rgba-float16', 1],
      'InvalidStateError'
    ])
  end

  # The order of its refusals (HTML's getImageData steps): no area, then a bitmap not origin-clean, then a pixel array too
  # large to make.
  it 'refuses a getImageData in the order HTML says' do
    png = File.binread(File.expand_path('wpt/images/green-1x1.png', __dir__))
    s = simulated_session(->(env) {
      if env['PATH_INFO'] == '/a.png'
        [200, {'content-type' => 'image/png'}, [png]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
      end
    })
    s.visit('/')
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const threw = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const ctx = document.createElement('canvas').getContext('2d');
      const before = [threw(() => ctx.getImageData(0, 0, 0, 1)), threw(() => ctx.getImageData(0, 0, 100000, 100000)), threw(() => ctx.getImageData(0, 0, 1, 1))];
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        done([...before, threw(() => ctx.getImageData(0, 0, 1, 0)), threw(() => ctx.getImageData(0, 0, 100000, 100000))]);
      };
      img.src = 'http://other.test/a.png';
    JS
    expect(got).to eq(%w[IndexSizeError RangeError none IndexSizeError SecurityError])
  end

  # HTML: "When the filtering algorithm requires a pixel value from outside the source rectangle but inside the original
  # image data, then the value from the original image data must be used." A pixel of the source rectangle scaled up blends
  # with its neighbour past the rectangle (Chrome blends too, 143,0,111 at this pixel; Firefox holds at the rectangle). A
  # source rectangle past the image paints only what is on it, smoothed as not: "the source rectangle must be clipped to the
  # source image and the destination rectangle must be clipped in the same proportion".
  it 'samples past the source rectangle, within the image' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const s = new OffscreenCanvas(2, 1), sg = s.getContext('2d');
        sg.fillStyle = '#f00'; sg.fillRect(0, 0, 1, 1);
        sg.fillStyle = '#00f'; sg.fillRect(1, 0, 1, 1);
        const d = new OffscreenCanvas(40, 40), g = d.getContext('2d');
        g.drawImage(s, 0, 0, 1, 1, 0, 0, 40, 40);
        const edge = [...g.getImageData(39, 20, 1, 1).data], near = [...g.getImageData(0, 20, 1, 1).data];
        g.reset();
        g.drawImage(s, -1, 0, 2, 1, 0, 0, 40, 40);
        return [edge, near, g.getImageData(10, 20, 1, 1).data[3], g.getImageData(30, 20, 1, 1).data[3]];
      })()
    JS
    expect(got).to eq([[131, 0, 124, 255], [255, 0, 0, 255], 0, 255])
  end

  # HTML: "When a CanvasSettings object's alpha is false, then its alpha component must be fixed to 1.0 (fully opaque) for
  # all pixels, and attempts to change the alpha component of any pixel must be silently ignored. Thus, the bitmap of such a
  # context starts off as opaque black [...] clearRect() always results in opaque black pixels, every fourth byte from
  # getImageData() is always 255, the putImageData() method effectively ignores every fourth byte in its input". Chrome reads
  # an untouched one as 0,0,0,0 and keeps a put's alpha, Firefox blends a put over black: the text rules both.
  it 'keeps a bitmap with no alpha opaque' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const make = () => { const c = document.createElement('canvas'); c.width = c.height = 4; return c.getContext('2d', {alpha: false}); };
        const px = (g, x = 1) => [...g.getImageData(x, 1, 1, 1).data];
        const red = (g) => { g.fillStyle = 'red'; g.fillRect(0, 0, 4, 4); return g; };
        const out = {};
        out.untouched = px(make());
        { const g = make(); g.fillStyle = 'rgba(255,0,0,0.5)'; g.fillRect(0, 0, 4, 4); out.half = px(g); }
        { const g = red(make()); g.clearRect(0, 0, 4, 4); out.clear = px(g); }
        { const g = red(make()); g.globalCompositeOperation = 'copy'; g.fillStyle = '#0f0'; g.fillRect(3, 3, 1, 1); out.copy = px(g); }
        { const g = red(make()); g.globalCompositeOperation = 'clear'; g.fillRect(0, 0, 4, 4); out.clearOp = px(g); }
        { const g = red(make()); g.globalCompositeOperation = 'destination-out'; g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, 4, 4); out.destinationOut = px(g); }
        { const g = make(); g.putImageData(new ImageData(new Uint8ClampedArray(64).fill(128), 4, 4), 0, 0); out.put = px(g); }
        { const g = red(make()); g.reset(); out.reset = px(g); }
        { const g = red(make()); g.canvas.width = 4; out.resize = px(g); }
        { const g = make(); out.outside = px(g, 4); }
        const into = new OffscreenCanvas(4, 4).getContext('2d');
        into.drawImage(make().canvas, 0, 0);
        out.source = px(into);
        const off = new OffscreenCanvas(4, 4), og = off.getContext('2d', {alpha: false});
        const bitmap = off.transferToImageBitmap();
        const fromBitmap = new OffscreenCanvas(4, 4).getContext('2d');
        fromBitmap.drawImage(bitmap, 0, 0);
        out.transferred = px(fromBitmap);
        out.afterTransfer = px(og);
        out.pattern = make().createPattern(make().canvas, 'repeat') !== null;
        return out;
      })()
    JS
    black = [0, 0, 0, 255]
    expect(got).to eq(
      'untouched' => black, 'half' => [128, 0, 0, 255], 'clear' => black, 'copy' => black, 'clearOp' => black,
      'destinationOut' => [128, 0, 0, 255], 'put' => [128, 128, 128, 255], 'reset' => black, 'resize' => black,
      'outside' => [0, 0, 0, 0], 'source' => black, 'transferred' => black, 'afterTransfer' => black, 'pattern' => true
    )
  end

  # HTML's drawing model: "Convert the image A to the context's color space." "The color space for CSS colors is defined in
  # CSS Color", and a gradient's stops are "converted to the context's color space", between which they "must be linearly
  # interpolated in the context's color space". So a gray of 128 is stored as 55 in a linear bitmap, by every colour path
  # (Chrome: fill 55, as srgb 128; blending there 155; drawn into an sRGB canvas 205; Firefox has no linear context).
  it 'stores the colours it is given in a linear colour space as such' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const fresh = (colorSpace = 'srgb-linear') => new OffscreenCanvas(8, 8).getContext('2d', {colorSpace});
      const px = (g, settings) => [...g.getImageData(1, 1, 1, 1, settings).data];
      const gray = 'rgb(128,128,128)';
      (async () => {
        const out = {};
        { const g = fresh(); g.fillStyle = gray; g.fillRect(0, 0, 8, 8); out.fill = px(g); out.asSrgb = px(g, {colorSpace: 'srgb'});
          g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 0, 8, 8); out.blend = px(g);
          const into = new OffscreenCanvas(8, 8).getContext('2d'); into.drawImage(g.canvas, 0, 0); out.intoSrgb = px(into);
          const tile = new OffscreenCanvas(8, 8).getContext('2d'); tile.fillStyle = tile.createPattern(g.canvas, 'repeat'); tile.fillRect(0, 0, 8, 8); out.patternIntoSrgb = px(tile);
          const made = new OffscreenCanvas(8, 8).getContext('2d'); made.drawImage(await createImageBitmap(g.canvas), 0, 0); out.bitmapIntoSrgb = px(made); }
        { const g = fresh(); g.strokeStyle = gray; g.lineWidth = 20; g.strokeRect(1, 1, 2, 2); out.stroke = px(g); }
        { const g = fresh(); g.shadowColor = gray; g.shadowOffsetX = 100; g.fillRect(-100, 0, 100, 8); out.shadow = px(g); }
        { const g = fresh(); const s = g.createLinearGradient(0, 0, 8, 0); s.addColorStop(0, gray); s.addColorStop(1, gray); g.fillStyle = s; g.fillRect(0, 0, 8, 8); out.gradient = px(g); }
        { const g = fresh(); const s = g.createLinearGradient(0, 0, 8, 0); s.addColorStop(0, '#000'); s.addColorStop(1, '#fff'); g.fillStyle = s; g.fillRect(0, 0, 8, 8);
          out.interpolated = [...g.getImageData(4, 1, 1, 1).data][0]; }
        { const g = fresh(); g.fillStyle = gray; g.font = '40px sans-serif'; g.textBaseline = 'middle'; g.fillText('\\u2588', -4, 4); out.text = px(g); }
        { const s = new OffscreenCanvas(8, 8).getContext('2d'); s.fillStyle = gray; s.fillRect(0, 0, 8, 8);
          const g = fresh(); g.drawImage(s.canvas, 0, 0); out.image = px(g);
          const t = fresh(); t.fillStyle = t.createPattern(s.canvas, 'repeat'); t.fillRect(0, 0, 8, 8); out.pattern = px(t); }
        { const g = fresh('display-p3-linear'); g.fillStyle = gray; g.fillRect(0, 0, 8, 8); out.p3Linear = px(g); }
        { const o = new OffscreenCanvas(8, 8), g = o.getContext('2d', {colorSpace: 'srgb-linear'}); g.fillStyle = gray; g.fillRect(0, 0, 8, 8);
          const t = new OffscreenCanvas(8, 8).getContext('2d'); t.drawImage(o.transferToImageBitmap(), 0, 0); out.transferred = px(t); }
        { const c = document.createElement('canvas'), g = c.getContext('2d', {colorSpace: 'srgb-linear'}); g.fillStyle = gray; g.fillRect(0, 0, 8, 8);
          out.file = c.toDataURL(); }
        done(out);
      })();
    JS
    file = got.delete('file')
    decoded = Capybara::Simulated::Native.decode_image(file.split(',', 2).last.unpack1('m'), 0, 0)
    expect(decoded['bytes'].bytes.first(4)).to eq([128, 128, 128, 255])
    expect(got).to eq(
      'fill' => [55, 55, 55, 255], 'asSrgb' => [128, 128, 128, 255], 'blend' => [155, 155, 155, 255],
      'intoSrgb' => [205, 205, 205, 255], 'patternIntoSrgb' => [205, 205, 205, 255], 'bitmapIntoSrgb' => [205, 205, 205, 255],
      'stroke' => [55, 55, 55, 255], 'shadow' => [55, 55, 55, 255], 'gradient' => [55, 55, 55, 255], 'interpolated' => 143,
      'text' => [55, 55, 55, 255], 'image' => [55, 55, 55, 255], 'pattern' => [55, 55, 55, 255],
      'p3Linear' => [55, 55, 55, 255], 'transferred' => [128, 128, 128, 255]
    )
  end

  # HTML: "Queue a global task, using the bitmap task source, to resolve promise with imageBitmap." — so no microtask queued
  # after the call sees it settled (Firefox `micro0,micro1,micro2,task,bitmap`, where Chrome has it after the first); its
  # refusals of what it was given "return a promise rejected" at once, and a Blob that does not decode is a task's as well.
  it 'settles createImageBitmap in a task' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [];
      const chain = (name) => Promise.resolve().then(() => log.push(name + '0')).then(() => log.push(name + '1')).then(() => log.push(name + '2'));
      const made = createImageBitmap(new ImageData(1, 1)).then(() => log.push('made'));
      const refused = createImageBitmap(new ImageData(1, 1), 0, 0, 0, 1).catch((e) => log.push(e.name));
      const blob = createImageBitmap(new Blob(['not an image'])).catch((e) => log.push('blob ' + e.name));
      chain('m');
      Promise.all([made, refused, blob]).then(() => done(log));
    JS
    expect(got.first(4)).to eq(%w[RangeError m0 m1 m2])
    expect(got.drop(4)).to contain_exactly('made', 'blob InvalidStateError')
  end

  # A page's `Array.prototype[Symbol.iterator]` is its own: nothing a canvas does for it goes through one, as in Chrome and
  # Firefox, where an empty one changes nothing. (An argument the page gives as a sequence is the page's to iterate.)
  it 'runs no iterator of the page for its own arguments' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const make = (w = 10, h = 10) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
      const source = make(4, 4);
      source.getContext('2d').fillRect(0, 0, 4, 4);
      (async () => {
        const bitmap = await createImageBitmap(source), data = new ImageData(1, 1);
        const own = Array.prototype[Symbol.iterator];
        let calls = 0;
        Array.prototype[Symbol.iterator] = function () { calls++; return {next: () => ({done: true})}; };
        const alpha = (g) => g.getImageData(0, 0, 1, 1).data[3];
        const out = {};
        const op = (name, f) => { const before = calls; out[name] = [f(), calls - before]; };
        op('drawImage', () => { const g = make().getContext('2d'); g.drawImage(source, 0, 0); return alpha(g); });
        op('drawBitmap', () => { const g = make().getContext('2d'); g.drawImage(bitmap, 0, 0); return alpha(g); });
        op('createPattern', () => make().getContext('2d').createPattern(source, 'repeat') !== null);
        op('fillRect', () => { const g = make(7, 9).getContext('2d'); g.fillRect(0, 0, 99, 99); return alpha(g); });
        op('resize', () => { const c = make(), g = c.getContext('2d'); c.width = 5; g.fillRect(0, 0, 9, 9); return alpha(g); });
        op('fillText', () => { const g = make().getContext('2d'); g.fillText('x', 1, 1); return g.measureText('x').width > 0; });
        op('roundRect', () => { const g = make().getContext('2d'); g.roundRect(0, 0, 4, 4, 0); g.fill(); return alpha(g); });
        op('transfer', () => { const o = new OffscreenCanvas(2, 2); o.getContext('2d'); return o.transferToImageBitmap().width; });
        op('offscreen', () => new OffscreenCanvas(2, 3).getContext('2d').getImageData(0, 0, 1, 1).data[3]);
        op('imageData', () => new ImageData(new Uint8ClampedArray(4), 1).width + new ImageData(1, 1).height);
        op('path', () => { const p = new Path2D(); p.rect(0, 0, 1, 1); const g = make().getContext('2d'); g.fill(new Path2D(p)); return alpha(g); });
        const before = calls;
        const bitmaps = [createImageBitmap(source), createImageBitmap(source, 0, 0, 2, 2), createImageBitmap(data)];
        const counted = calls - before;
        Array.prototype[Symbol.iterator] = own;
        out.createImageBitmap = [(await bitmaps[1]).width, counted];
        done(out);
      })();
    JS
    expect(got).to eq(
      'drawImage' => [255, 0], 'drawBitmap' => [255, 0], 'createPattern' => [true, 0], 'fillRect' => [255, 0], 'resize' => [255, 0],
      'fillText' => [true, 0], 'roundRect' => [255, 0], 'transfer' => [2, 0], 'offscreen' => [0, 0],
      'imageData' => [2, 0], 'path' => [255, 0], 'createImageBitmap' => [2, 0]
    )
  end

  # A float16 ImageData's array is the platform's, whatever a page's global `Float16Array` has become.
  it 'makes its pixel arrays whatever the page replaced' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const type = (d) => Object.prototype.toString.call(d.data);
        const own = window.Float16Array;
        const settings = {pixelFormat: 'rgba-float16'};
        const ctx = new OffscreenCanvas(1, 1).getContext('2d');
        ctx.fillRect(0, 0, 1, 1);
        window.Float16Array = function () { throw new Error('the page\\'s'); };
        const out = [type(new ImageData(1, 1, settings)), type(ctx.getImageData(0, 0, 1, 1, settings)), type(ctx.createImageData(1, 1, settings))];
        out.push(ctx.getImageData(0, 0, 1, 1, settings).data[3]);
        window.Float16Array = own;
        return out;
      })()
    JS
    expect(got).to eq(['[object Float16Array]', '[object Float16Array]', '[object Float16Array]', 1])
  end

  # HTML's drawFocusIfNeeded: "If element is not focused or is not a descendant of context's canvas element, then return" —
  # so the canvas itself, focused, is none (base drew for it: `contains` is inclusive).
  it 'draws a focus ring for a focused descendant alone' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = document.body.appendChild(document.createElement('canvas'));
        canvas.tabIndex = 0;
        const inside = canvas.appendChild(document.createElement('button'));
        const outside = document.body.appendChild(document.createElement('button'));
        const ctx = canvas.getContext('2d');
        ctx.rect(5, 5, 20, 20);
        const drawn = (element) => {
          ctx.clearRect(0, 0, 300, 150);
          ctx.drawFocusIfNeeded(element);
          return ctx.getImageData(5, 15, 1, 1).data[3] > 0;
        };
        const out = [];
        inside.focus();
        out.push(drawn(inside), drawn(outside));
        outside.focus();
        out.push(drawn(inside), drawn(outside));
        canvas.focus();
        out.push(document.activeElement === canvas, drawn(canvas));
        return out;
      })()
    JS
    expect(got).to eq([true, false, false, false, true, false])
  end

  # A gradient's stops are "converted to the context's color space", between which they "must be linearly interpolated in the
  # context's color space". Chrome interpolates in sRGB: display-p3 red -> blue at x=50 reads 115,20,124 there and 116,25,141
  # here, a figure kept beside the spec for that reason (before: 115,20,125).
  it 'interpolates a gradient in the bitmap\'s colour space' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const g = new OffscreenCanvas(100, 1).getContext('2d', {colorSpace: 'display-p3'});
        const s = g.createLinearGradient(0, 0, 100, 0);
        s.addColorStop(0, 'red');
        s.addColorStop(1, 'blue');
        g.fillStyle = s;
        g.fillRect(0, 0, 100, 1);
        return [...g.getImageData(50, 0, 1, 1).data];
      })()
    JS
    expect(got).to eq([116, 25, 141, 255])
  end

  # A bitmap with no alpha has its pixels looked at only where an operation can have lowered them: a pixel an operation
  # does not reach keeps what it was read as, a shadow's reach is the bitmap, and a read of one never drawn makes no bitmap,
  # however large a canvas it is (a 30000² one fits no test's budget otherwise).
  it 'bounds its alpha:false work by what an operation reaches' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const make = () => new OffscreenCanvas(8, 8).getContext('2d', {alpha: false});
        const px = (g, x, y) => [...g.getImageData(x, y, 1, 1).data];
        const out = {};
        { const g = make(); g.fillStyle = '#f00'; g.fillRect(0, 0, 8, 8); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(0,255,0,.5)'; g.fillRect(1, 1, 1, 1); out.atop = [px(g, 1, 1), px(g, 2, 1)]; }
        { const g = make(); g.fillStyle = '#f00'; g.fillRect(0, 0, 8, 8); g.clearRect(1, 1, 2, 2); out.clear = [px(g, 2, 2), px(g, 3, 3)]; }
        { const g = make(); g.fillStyle = '#f00'; g.fillRect(0, 0, 8, 8); g.shadowColor = '#000'; g.shadowOffsetX = 4; g.globalCompositeOperation = 'destination-out'; g.fillRect(0, 0, 2, 2); out.shadow = px(g, 5, 1)[3]; }
        { const g = make(); g.fillStyle = '#f00'; g.fillRect(0, 0, 8, 8); g.putImageData(new ImageData(new Uint8ClampedArray([0, 0, 255, 0]), 1, 1), 2, 2); out.put = [px(g, 2, 2), px(g, 3, 2)]; }
        const huge = document.createElement('canvas');
        huge.width = huge.height = 30000;
        const h = huge.getContext('2d', {alpha: false});
        out.untouched = [px(h, 5, 5), px(h, 30000, 5)];
        return out;
      })()
    JS
    expect(got).to eq(
      'atop' => [[128, 128, 0, 255], [255, 0, 0, 255]],
      'clear' => [[0, 0, 0, 255], [255, 0, 0, 255]],
      'shadow' => 255,
      'put' => [[0, 0, 255, 255], [255, 0, 0, 255]],
      'untouched' => [[0, 0, 0, 255], [0, 0, 0, 0]]
    )
  end

  # What the engine allocates for a page is V8's to count as it allocates: a loop of dead bitmaps is collected as it goes.
  # Stores made in Rust and attached later put no pressure on the heap, and 4 GB of dead `getImageData` peaked at the 4 GB.
  it 'leaves dead pixels for the collector as they churn', if: File.exist?('/proc/self/clear_refs') do
    session
    File.write('/proc/self/clear_refs', '5')
    before = File.read('/proc/self/status')[/VmRSS:\s+(\d+)/, 1].to_i
    session.evaluate_script(<<~JS)
      (() => {
        const c = new OffscreenCanvas(1000, 1000), g = c.getContext('2d');
        g.fillRect(0, 0, 1, 1);
        for (let i = 0; i < 1000; i++) g.getImageData(0, 0, 1000, 1000);
        const clipped = new OffscreenCanvas(1000, 1000).getContext('2d');
        for (let i = 0; i < 1000; i++) { clipped.rect(0, 0, 1, 1); clipped.clip(); clipped.reset(); }
        for (let i = 0; i < 500; i++) new OffscreenCanvas(1000, 1000).getContext('2d').fillRect(0, 0, 1, 1);
        return 0;
      })()
    JS
    peak = File.read('/proc/self/status')[/VmHWM:\s+(\d+)/, 1].to_i
    expect(peak - before).to be < 1_500_000
  end

  # createImageBitmap, for an ImageData: "If IsDetachedBuffer(buffer) is true, then return a promise rejected with an
  # "InvalidStateError" DOMException." — after its own arguments' refusals ("If either sw or sh is given and is 0, then
  # return a promise rejected with a RangeError."; a resize of 0, an InvalidStateError) — and a bitmap of it its own
  # pixels: a linear one's encoded, a float16 one's 8-bit, an array changed later not in it.
  it 'takes an ImageData as createImageBitmap says' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const rejected = (p) => p.then(() => 'none', (e) => e.name);
      const pixels = (bm) => {
        const ctx = new OffscreenCanvas(1, 1).getContext('2d');
        ctx.drawImage(bm, 0, 0);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      (async () => {
        const gone = new ImageData(1, 1);
        structuredClone(gone.data.buffer, {transfer: [gone.data.buffer]});
        const live = new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
        const kept = await createImageBitmap(live);
        live.data[0] = 200;
        done([
          await rejected(createImageBitmap(gone)),
          await rejected(createImageBitmap(gone, 0, 0, 0, 1)),
          await rejected(createImageBitmap(gone, {resizeWidth: 0})),
          pixels(kept),
          pixels(await createImageBitmap(new ImageData(new Uint8ClampedArray([128, 0, 0, 255]), 1, 1, {colorSpace: 'srgb-linear'}))),
          pixels(await createImageBitmap(new ImageData(new Float16Array([0.5, 0, 0, 1]), 1, 1, {pixelFormat: 'rgba-float16'})))
        ]);
      })();
    JS
    expect(got).to eq(['InvalidStateError', 'RangeError', 'InvalidStateError', [1, 2, 3, 255], [188, 0, 0, 255], [128, 0, 0, 255]])
  end
end
