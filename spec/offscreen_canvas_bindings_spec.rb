# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# OffscreenCanvas and ImageBitmap, generated from their IDL: their state in internal slots, an OffscreenCanvas an
# EventTarget, an ImageBitmap made by the platform alone.
RSpec.describe 'OffscreenCanvas and ImageBitmap bindings' do
  # (…a worker that sends back what it gets: an image's class, size and first pixel, and an ImageBitmap of its own)
  let(:worker_js) {
    <<~JS
      self.onmessage = async (e) => {
        const v = e.data;
        if (v.point) {
          self.postMessage({point: [v.point instanceof DOMPoint, v.point.x, v.point.w], canvas: [v.canvas instanceof OffscreenCanvas, v.canvas.width]});
          return;
        }
        const ctx = new OffscreenCanvas(1, 1).getContext('2d');
        if (v instanceof ImageBitmap) ctx.drawImage(v, 0, 0); else ctx.putImageData(v, 0, 0);
        const canvas = new OffscreenCanvas(4, 3);
        canvas.getContext('2d').fillRect(0, 0, 4, 3);
        self.postMessage({kind: Object.prototype.toString.call(v), w: v.width, h: v.height,
                          px: [...ctx.getImageData(0, 0, 1, 1).data], own: canvas.transferToImageBitmap()});
      };
    JS
  }
  let(:session) {
    js = worker_js
    s = simulated_session(lambda {|env|
      if env['PATH_INFO'] == '/worker.js'
        [200, {'content-type' => 'application/javascript'}, [js]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']]
      end
    })
    s.visit('/')
    s
  }

  def error(js) = "(() => { try { #{js}; return 'none'; } catch (e) { return e.name; } })()"

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = new OffscreenCanvas(3, 2);
        const bare = new OffscreenCanvas(1, 1);
        return [
          [Object.prototype.toString.call(canvas), Object.keys(canvas), canvas instanceof EventTarget, canvas.width, canvas.height],
          #{error('new OffscreenCanvas(1)')},
          #{error('new OffscreenCanvas(-1, 1)')},
          #{error('canvas.width = Infinity')},
          #{error("canvas.getContext('nope')")},
          [canvas.getContext('bitmaprenderer'), canvas.getContext('webgl'), canvas.getContext('2d') === canvas.getContext('2d')],
          #{error('bare.transferToImageBitmap()')},
          #{error("new OffscreenCanvas(1, 1).getContext('2d', {colorSpace: 'bogus'})")},
          new OffscreenCanvas(1, 1).getContext('2d', {alpha: 0, willReadFrequently: 1}).getContextAttributes(),
          #{error('new ImageBitmap()')},
          #{error("Object.getOwnPropertyDescriptor(OffscreenCanvas.prototype, 'width').get.call({})")}
        ];
      })()
    JS
    expect(got).to eq([
      ['[object OffscreenCanvas]', [], true, 3, 2],
      'TypeError', 'TypeError', 'TypeError', 'TypeError',
      [nil, nil, true],
      'InvalidStateError',
      'TypeError',
      {'alpha' => false, 'colorSpace' => 'srgb', 'colorType' => 'unorm8', 'desynchronized' => false, 'willReadFrequently' => true},
      'TypeError',
      'TypeError'
    ])
  end

  # An ImageBitmap's state is its slots': a clone copies its pixels, a transfer closes the source, and a closed one is
  # neither cloned nor transferred (a DataCloneError, its [[Detached]] flag).
  it 'clones, transfers and closes as HTML says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = new OffscreenCanvas(2, 1);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0f0';
        ctx.fillRect(0, 0, 2, 1);
        const bitmap = canvas.transferToImageBitmap();
        const clone = structuredClone(bitmap);
        const moved = structuredClone(bitmap, {transfer: [bitmap]});
        const out = new OffscreenCanvas(2, 1).getContext('2d');
        out.drawImage(moved, 0, 0);
        return [
          [Object.prototype.toString.call(clone), Object.keys(clone), clone.width, clone.height],
          [bitmap.width, bitmap.height, moved.width],
          [...out.getImageData(1, 0, 1, 1).data],
          #{error('structuredClone(bitmap)')},
          #{error('structuredClone(bitmap, {transfer: [bitmap]})')}
        ];
      })()
    JS
    expect(got).to eq([
      ['[object ImageBitmap]', [], 2, 1],
      [0, 0, 2],
      [0, 255, 0, 255],
      'DataCloneError',
      'DataCloneError'
    ])
  end

  # Across isolates too (a worker's postMessage carries JSON): an ImageBitmap and an ImageData arrive as themselves, their
  # pixels with them, a transferred bitmap closed at the sender — a worker's own bitmap arriving the same way.
  it "posts an ImageBitmap and an ImageData to and from a worker" do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const canvas = new OffscreenCanvas(2, 2);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#00f';
        ctx.fillRect(0, 0, 2, 2);
        const bitmap = canvas.transferToImageBitmap();
        const worker = new Worker('/worker.js');
        const reply = () => new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); });
        worker.postMessage(bitmap, [bitmap]);
        const a = await reply();
        worker.postMessage(new ImageData(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1));
        const b = await reply();
        return [[a.kind, a.w, a.h, a.px], bitmap.width, [b.kind, b.px],
                [Object.prototype.toString.call(a.own), a.own.width, a.own.height]];
      })().then(done, (e) => done(String(e)));
    JS
    expect(got).to eq([
      ['[object ImageBitmap]', 2, 2, [0, 0, 255, 255]], 0, ['[object ImageData]', [255, 0, 0, 255]],
      ['[object ImageBitmap]', 4, 3]
    ])
  end

  # A transfer detaches its sources only once the whole message is serialized, by the slots (not a page's `close`); an
  # OffscreenCanvas transfers as one of its size, refused with a context (InvalidStateError) or detached already
  # (DataCloneError), and the source detached; a closed bitmap is no image source (Chrome: each the same).
  it 'transfers as HTML says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = new OffscreenCanvas(2, 1);
        canvas.getContext('2d').fillRect(0, 0, 2, 1);
        const bitmap = canvas.transferToImageBitmap();
        const failed = #{error('structuredClone({bitmap, f() {}}, {transfer: [bitmap]})')};
        let called = 0;
        const close = ImageBitmap.prototype.close;
        ImageBitmap.prototype.close = function () { called++; };
        const moved = structuredClone(bitmap, {transfer: [bitmap]});
        ImageBitmap.prototype.close = close;
        const ctx = new OffscreenCanvas(1, 1).getContext('2d');
        const bare = new OffscreenCanvas(3, 2);
        const movedCanvas = structuredClone(bare, {transfer: [bare]});
        return [
          failed, [called, bitmap.width, moved.width],
          #{error('ctx.drawImage(bitmap, 0, 0)')}, #{error("ctx.createPattern(bitmap, 'repeat')")},
          [movedCanvas instanceof OffscreenCanvas, movedCanvas.width, movedCanvas.height, Object.keys(bare), bare.width],
          #{error("bare.getContext('2d')")}, #{error('structuredClone(bare, {transfer: [bare]})')},
          #{error('structuredClone(canvas, {transfer: [canvas]})')},
          #{error('structuredClone(new OffscreenCanvas(1, 1))')},
          document.createElement('canvas').getContext({toString: () => '2d'}) !== null
        ];
      })()
    JS
    expect(got).to eq([
      'DataCloneError', [0, 0, 2],
      'InvalidStateError', 'InvalidStateError',
      [true, 3, 2, [], 0],
      'InvalidStateError', 'DataCloneError',
      'InvalidStateError',
      'DataCloneError',
      true
    ])
  end

  # Across isolates a geometry object arrives as itself (NaN and infinities with it), a transferred OffscreenCanvas as
  # one of its size, and one not transferred — any platform object that is no structured-clone value — is a
  # DataCloneError at postMessage, never a `{}` at the far end.
  it 'posts geometry and a transferred OffscreenCanvas to a worker, and refuses what cannot be cloned' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const worker = new Worker('/worker.js');
        const reply = () => new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); });
        const canvas = new OffscreenCanvas(5, 4);
        worker.postMessage({point: new DOMPoint(NaN, 2, 3, -Infinity), canvas}, [canvas]);
        const a = await reply();
        let refused;
        try { worker.postMessage(new OffscreenCanvas(1, 1)); refused = 'none'; } catch (e) { refused = e.name; }
        // (…a getter read once, as a structured clone reads it)
        let gets = 0;
        try { worker.postMessage({get g() { gets++; return 1; }, point: new DOMPoint(), canvas: {width: 0}}); } catch (_) {}
        await reply();
        return [a.point[0], String(a.point[1]), a.point[2] === -Infinity, a.canvas, canvas.width, refused, gets];
      })().then(done, (e) => done(String(e)));
    JS
    expect(got).to eq([true, 'NaN', true, [true, 5], 0, 'DataCloneError', 1])
  end
end
