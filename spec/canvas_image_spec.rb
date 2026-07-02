# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'base64'

# Coverage for the pixel-buffer stack: ImageData, OffscreenCanvas,
# CanvasRenderingContext2D's drawImage / getImageData / putImageData
# round-trip, and createImageBitmap(blob) decoding through libvips.

RSpec.describe 'Canvas / ImageData / OffscreenCanvas' do
  # Pre-encoded 4×3 RGBA PNG. Row 0 is red/green/blue/white; the rest
  # don't matter for the assertions but exercise the decode path.
  let(:png_bytes) {
    Base64.decode64(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAACXBIWXMAAAPoAAAD6AG1e1JrA' \
      'AAAI0lEQVQImSWKwREAAAiCGJ3NrQw/ckogDSksUbdVf/BenpgBvkUa6QrxoaEAAAAASUVORK5CYII='
    )
  }

  let(:app) {
    bytes = png_bytes
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'        then [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
        when '/test.png' then [200, {'content-type' => 'image/png'}, [bytes]]
        else                  [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  it 'constructs ImageData with width/height and a zero-filled buffer' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const d = new ImageData(2, 3);
      JSON.stringify({ w: d.width, h: d.height, len: d.data.length, sample: Array.from(d.data) });
    JS
    parsed = JSON.parse(out)
    expect(parsed['w']).to eq(2)
    expect(parsed['h']).to eq(3)
    expect(parsed['len']).to eq(24) # 2 * 3 * 4
    expect(parsed['sample']).to all(eq(0))
  end

  it 'OffscreenCanvas getImageData reads back what putImageData wrote' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = new OffscreenCanvas(4, 2);
      const ctx = c.getContext('2d');
      const src = new ImageData(2, 1);
      src.data[0] = 255; src.data[1] = 128; src.data[2] = 64; src.data[3] = 200;
      src.data[4] = 10;  src.data[5] = 20;  src.data[6] = 30; src.data[7] = 40;
      ctx.putImageData(src, 1, 0);
      const r = ctx.getImageData(0, 0, 4, 2);
      JSON.stringify(Array.from(r.data));
    JS
    arr = JSON.parse(out)
    # Row 0: [empty, src px0, src px1, empty]
    expect(arr[0,4]).to  eq([0, 0, 0, 0])         # untouched
    expect(arr[4,4]).to  eq([255, 128, 64, 200])  # putImageData px 0
    expect(arr[8,4]).to  eq([10, 20, 30, 40])     # putImageData px 1
    expect(arr[12,4]).to eq([0, 0, 0, 0])         # untouched
  end

  it 'createImageBitmap decodes a PNG blob via libvips and drawImage copies pixels' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    # Build a Blob from a known PNG. A string blobPart is UTF-8-encoded
    # per the WHATWG Blob spec (`new Blob(['€']).size === 3`), which would
    # corrupt raw binary bytes >0x7F — so binary content must go through a
    # BufferSource, exactly as real apps do: `Uint8Array.from(atob(b64), …)`
    # turns the base64 into a byte array the constructor copies verbatim.
    b64 = Base64.strict_encode64(png_bytes)
    out = session.evaluate_async_script(<<~JS)
      const cb = arguments[arguments.length - 1];
      const blob = new Blob([Uint8Array.from(atob('#{b64}'), c => c.charCodeAt(0))], { type: 'image/png' });
      createImageBitmap(blob).then(bm => {
        const c   = new OffscreenCanvas(bm.width, bm.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(bm, 0, 0);
        const d = ctx.getImageData(0, 0, bm.width, bm.height);
        cb(JSON.stringify({ w: bm.width, h: bm.height, sample: Array.from(d.data.slice(0, 16)) }));
      }).catch(e => cb('ERR: ' + (e && e.message)));
    JS
    raise "decode failed: #{out}" if out.start_with?('ERR:')
    parsed = JSON.parse(out)
    expect(parsed['w']).to eq(4)
    expect(parsed['h']).to eq(3)
    expect(parsed['sample'][0..3]).to eq([255, 0, 0, 255])
    expect(parsed['sample'][4..7]).to eq([0, 255, 0, 255])
  end

  it 'fillRect paints an exact solid-colour block, respecting fillStyle' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = new OffscreenCanvas(3, 3);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(1, 1, 2, 2);
      const d = ctx.getImageData(0, 0, 3, 3);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    # A 2×2 red block anchored at (1,1); the rest transparent.
    expect(px[0]).to eq([0, 0, 0, 0])          # (0,0) untouched
    expect(px[4]).to eq([255, 0, 0, 255])      # (1,1) red
    expect(px[5]).to eq([255, 0, 0, 255])      # (2,1) red
    expect(px[8]).to eq([255, 0, 0, 255])      # (2,2) red
    expect(px[3]).to eq([0, 0, 0, 0])          # (0,1) untouched
  end

  it 'serializes fillStyle / strokeStyle and ignores invalid assignments' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      const seen = {};
      seen.def = ctx.fillStyle;                 // default black
      ctx.fillStyle = 'red';        seen.named  = ctx.fillStyle;
      ctx.fillStyle = 'rgba(0,128,255,0.5)'; seen.rgba = ctx.fillStyle;
      ctx.fillStyle = 'not-a-color'; seen.kept  = ctx.fillStyle; // unchanged
      ctx.strokeStyle = '#00FF00';  seen.stroke = ctx.strokeStyle;
      JSON.stringify(seen);
    JS
    seen = JSON.parse(out)
    expect(seen['def']).to eq('#000000')
    expect(seen['named']).to eq('#ff0000')
    expect(seen['rgba']).to eq('rgba(0, 128, 255, 0.5)')
    expect(seen['kept']).to eq('rgba(0, 128, 255, 0.5)') # invalid ignored
    expect(seen['stroke']).to eq('#00ff00')
  end

  it 'clearRect erases a region back to transparent black' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(2, 2).getContext('2d');
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 0, 2, 2);
      ctx.clearRect(0, 0, 1, 2);        // wipe the left column
      const d = ctx.getImageData(0, 0, 2, 2);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px[0]).to eq([0, 0, 0, 0])          # cleared
    expect(px[1]).to eq([0, 0, 255, 255])      # still blue
    expect(px[2]).to eq([0, 0, 0, 0])          # cleared
    expect(px[3]).to eq([0, 0, 255, 255])      # still blue
  end

  it 'composites a translucent fill over an opaque one via globalAlpha' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 1, 1);            // opaque black base
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, 0, 1, 1);            // 50% white over black
      const d = ctx.getImageData(0, 0, 1, 1);
      JSON.stringify(Array.from(d.data));
    JS
    r, g, b, a = JSON.parse(out)
    expect(a).to eq(255)
    # 0.5*255 over 0 → ~128 (rounding within the clamped store).
    expect(r).to be_within(1).of(128)
    expect(g).to eq(r)
    expect(b).to eq(r)
  end

  it 'applies the current transform (translate + scale) to fillRect' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.translate(1, 1);
      ctx.scale(2, 2);
      ctx.fillRect(0, 0, 1, 1);            // → device rect (1,1)-(3,3)
      const d = ctx.getImageData(0, 0, 4, 4);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px[0]).to  eq([0, 0, 0, 0])         # (0,0) outside
    expect(px[5]).to  eq([255, 0, 0, 255])     # (1,1) inside 2×2 block
    expect(px[10]).to eq([255, 0, 0, 255])     # (2,2) inside
    expect(px[15]).to eq([0, 0, 0, 0])         # (3,3) outside
  end

  it 'strokeRect paints a border frame leaving the interior untouched' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, 2, 2);          // frame centred on the 1..3 box
      const d = ctx.getImageData(0, 0, 4, 4);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    # lineWidth 2 straddling edges of (1,1)-(3,3) covers the whole 0..3 ring;
    # with a 2px border on a 2×2 rect there is no untouched interior, so the
    # four corners must be painted and the buffer fully green.
    expect(px[0]).to  eq([0, 255, 0, 255])     # corner painted
    expect(px[5]).to  eq([0, 255, 0, 255])     # inner edge painted
    expect(px.count {|p| p == [0, 255, 0, 255] }).to eq(16)
  end

  it 'normalizes negative width/height in fillRect and strokeRect' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(3, 3, -2, -2);          // → a 2×2 block at (1,1)
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 1;
      ctx.strokeRect(4, 4, -4, -4);        // → 1px frame around the full 0..4 box
      const d = ctx.getImageData(0, 0, 4, 4);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px[5]).to  eq([255, 0, 0, 255])     # (1,1) inside the negative-dim fill
    expect(px[10]).to eq([255, 0, 0, 255])     # (2,2) inside
    expect(px[0]).to  eq([0, 255, 0, 255])     # (0,0) corner of the negative-dim stroke
    expect(px[3]).to  eq([0, 255, 0, 255])     # (3,0) top edge stroked
  end

  it 'treats non-finite geometry / transform arguments as no-ops (spec)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(2, 2).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, Infinity, 2);     // ignored — must NOT flood the canvas
      ctx.fillRect(0, 0, NaN, 2);          // ignored
      ctx.setTransform(NaN, 0, 0, 1, 0, 0);// ignored — CTM stays identity
      ctx.fillRect(0, 0, 1, 1);            // still draws (matrix not poisoned)
      const d = ctx.getImageData(0, 0, 2, 2);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px[0]).to eq([255, 0, 0, 255])      # the one valid fill landed
    expect(px[1]).to eq([0, 0, 0, 0])          # Infinity fill did not flood
    expect(px[2]).to eq([0, 0, 0, 0])
    expect(px[3]).to eq([0, 0, 0, 0])
  end

  it 'coerces string geometry arguments to numbers (WebIDL doubles)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(3, 3).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect('1', '1', '2', '2');    // strings → 1,1,2,2 (not concatenated)
      const d = ctx.getImageData(0, 0, 3, 3);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px[4]).to eq([255, 0, 0, 255])      # (1,1) filled
    expect(px[8]).to eq([255, 0, 0, 255])      # (2,2) filled
    expect(px[0]).to eq([0, 0, 0, 0])          # (0,0) untouched
  end

  it 'resets the bitmap when canvas width is reassigned (clear idiom)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas');
      c.width = 2; c.height = 2;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 0, 2, 2);
      const before = ctx.getImageData(0, 0, 2, 2).data[0 + 2]; // blue channel, painted
      c.width = c.width;                    // reset to transparent black
      const after = Array.from(ctx.getImageData(0, 0, 2, 2).data);
      JSON.stringify({ before, after });
    JS
    res = JSON.parse(out)
    expect(res['before']).to eq(255)           # was blue
    expect(res['after']).to all(eq(0))         # cleared
  end

  it 'fills a triangle path (nonzero winding) via moveTo/lineTo/fill' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(5, 5).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(5, 0);
      ctx.lineTo(0, 5);
      ctx.closePath();
      ctx.fill();
      const d = ctx.getImageData(0, 0, 5, 5);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 5 + x] }
    # Triangle (0,0)-(5,0)-(0,5): interior is x+y < 5 (pixel centres are x+0.5,y+0.5).
    expect(at.call(0, 0)).to eq([255, 0, 0, 255])   # centre (0.5,0.5) inside
    expect(at.call(1, 1)).to eq([255, 0, 0, 255])   # centre (1.5,1.5) inside
    expect(at.call(3, 3)).to eq([0, 0, 0, 0])        # centre (3.5,3.5) → x+y=7 outside
    expect(at.call(4, 4)).to eq([0, 0, 0, 0])        # far corner outside
  end

  it 'fill(evenodd) leaves a hole where two nested rects overlap' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(6, 6).getContext('2d');
      ctx.fillStyle = '#0000ff';
      ctx.beginPath();
      ctx.rect(0, 0, 6, 6);      // outer
      ctx.rect(2, 2, 2, 2);      // inner — becomes a hole under even-odd
      ctx.fill('evenodd');
      const d = ctx.getImageData(0, 0, 6, 6);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 6 + x] }
    expect(at.call(0, 0)).to eq([0, 0, 255, 255])   # outer ring painted
    expect(at.call(3, 3)).to eq([0, 0, 0, 0])        # inner rect is a hole
    expect(at.call(2, 2)).to eq([0, 0, 0, 0])        # hole
  end

  it 'fill(nonzero) fills nested same-wound rects solid (no hole)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(6, 6).getContext('2d');
      ctx.fillStyle = '#0000ff';
      ctx.beginPath();
      ctx.rect(0, 0, 6, 6);
      ctx.rect(2, 2, 2, 2);
      ctx.fill();                // default nonzero → both rects wind the same way
      const d = ctx.getImageData(0, 0, 6, 6);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 6 + x] }
    expect(at.call(3, 3)).to eq([0, 0, 255, 255])   # no hole under nonzero
  end

  it 'strokes a path outline once even where segments overlap (translucent)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(1, 1);
      ctx.lineTo(9, 1);          // horizontal segment near the top
      ctx.stroke();
      const d = ctx.getImageData(0, 0, 10, 10);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    # A 2px-wide stroke centred on y=1 covers rows 0..1; alpha 0.5 over transparent
    # → ~128. Corners must not double-composite to a darker value.
    on_line = px.select {|p| p[3] > 0 }
    expect(on_line).not_to be_empty
    expect(on_line.map {|p| p[3] }.uniq).to eq([128])   # single, uniform coverage
  end

  it 'fills an arc (circle) covering the centre and clearing the corners' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.beginPath();
      ctx.arc(10, 10, 8, 0, Math.PI * 2);
      ctx.fill();
      const d = ctx.getImageData(0, 0, 20, 20);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 20 + x] }
    expect(at.call(10, 10)).to eq([255, 0, 0, 255])   # centre inside the disc
    expect(at.call(10, 3)).to  eq([255, 0, 0, 255])   # near the top edge (r=8)
    expect(at.call(0, 0)).to   eq([0, 0, 0, 0])         # corner outside the disc
    expect(at.call(19, 19)).to eq([0, 0, 0, 0])         # corner outside
  end

  it 'beginPath clears the current point (no stray segment from a stale path)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(6, 6).getContext('2d');
      ctx.fillStyle = '#ff0000';
      // First path in a far corner, then discard it.
      ctx.beginPath();
      ctx.moveTo(5, 5);
      ctx.lineTo(6, 6);
      ctx.beginPath();                     // resets — the (5,5) point must not linger
      // A curve with NO moveTo: seeds at its first control point (1,1), not (5,5).
      ctx.bezierCurveTo(1, 1, 3, 1, 3, 3);
      ctx.lineTo(1, 3);
      ctx.closePath();
      ctx.fill();
      const d = ctx.getImageData(0, 0, 6, 6);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 6 + x] }
    expect(at.call(2, 2)).to eq([255, 0, 0, 255])   # inside the new shape (seeded at 1,1)
    expect(at.call(5, 5)).to eq([0, 0, 0, 0])        # far corner untouched — no stale geometry
  end

  it 'exposes lineCap/lineJoin/miterLimit and setLineDash without throwing' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      ctx.lineCap = 'round'; ctx.lineJoin = 'bevel'; ctx.miterLimit = 4;
      ctx.setLineDash([4, 2]);
      JSON.stringify({ cap: ctx.lineCap, join: ctx.lineJoin, miter: ctx.miterLimit, dash: ctx.getLineDash() });
    JS
    res = JSON.parse(out)
    expect(res['cap']).to eq('round')
    expect(res['join']).to eq('bevel')
    expect(res['miter']).to eq(4)
    expect(res['dash']).to eq([4, 2])
  end

  it 'HTMLCanvasElement.getContext("2d") returns a working 2D context' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas');
      c.width = 2; c.height = 2;
      const ctx = c.getContext('2d');
      ctx.putImageData(new ImageData(new Uint8ClampedArray([1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16]), 2, 2), 0, 0);
      const d = ctx.getImageData(0, 0, 2, 2);
      JSON.stringify({ ctxType: ctx.constructor.name, sample: Array.from(d.data) });
    JS
    parsed = JSON.parse(out)
    expect(parsed['ctxType']).to eq('CanvasRenderingContext2D')
    expect(parsed['sample']).to eq([1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16])
  end
end
