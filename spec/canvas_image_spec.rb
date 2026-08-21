# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'base64'
require 'timeout'
require_relative 'support/session_teardown'

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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    # The 1px stroke straddles the box edge, so corner/edge pixels are AA-partial;
    # assert they're painted green rather than a specific alpha.
    expect(px[0][1]).to eq(255); expect(px[0][3]).to be > 0   # (0,0) corner stroked
    expect(px[3][1]).to eq(255); expect(px[3][3]).to be > 0   # (3,0) top edge stroked
  end

  it 'treats non-finite geometry / transform arguments as no-ops (spec)' do
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    session = simulated_session(app)
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
    # Inside the new shape (seeded at its first control point 1,1); (2,2) sits near
    # the curved edge, so it's AA-partial — assert red and substantially covered.
    expect(at.call(2, 2)[0]).to eq(255)
    expect(at.call(2, 2)[3]).to be > 128
    expect(at.call(5, 5)).to eq([0, 0, 0, 0])        # far corner untouched — no stale geometry
  end

  it 'exposes lineCap/lineJoin/miterLimit and setLineDash without throwing' do
    session = simulated_session(app)
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

  it 'setLineDash duplicates an odd-length list and ignores invalid entries' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      ctx.setLineDash([1, 2, 3]);            // odd → concatenated with itself
      const odd = ctx.getLineDash();
      ctx.setLineDash(['4', '2']);           // string-coerced
      const strs = ctx.getLineDash();
      ctx.setLineDash([1, -2]);              // negative → ignored, keeps prior list
      const neg = ctx.getLineDash();
      ctx.setLineDash([1, NaN]);             // non-finite → ignored
      const nan = ctx.getLineDash();
      JSON.stringify({ odd, strs, neg, nan });
    JS
    res = JSON.parse(out)
    expect(res['odd']).to eq([1, 2, 3, 1, 2, 3])
    expect(res['strs']).to eq([4, 2])
    expect(res['neg']).to eq([4, 2])
    expect(res['nan']).to eq([4, 2])
  end

  it 'renders a dashed stroke and hit-tests it with butt caps' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(40, 3).getContext('2d');
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 10]);
      ctx.beginPath(); ctx.moveTo(0, 1.5); ctx.lineTo(40, 1.5); ctx.stroke();
      const at = (x) => ctx.getImageData(x, 1, 1, 1).data[3];   // alpha under the line
      JSON.stringify({
        on1: at(5), off: at(15), on2: at(25),      // dash on / gap / dash on
        hitOn: ctx.isPointInStroke(5, 1.5),         // inside a dash
        hitOff: ctx.isPointInStroke(15, 1.5),       // inside a gap → false
        hitPast: ctx.isPointInStroke(10.5, 1.5)     // just past a butt cap → false
      });
    JS
    res = JSON.parse(out)
    expect(res['on1']).to be > 0
    expect(res['off']).to eq(0)
    expect(res['on2']).to be > 0
    expect(res['hitOn']).to be(true)
    expect(res['hitOff']).to be(false)
    expect(res['hitPast']).to be(false)
  end

  it 'fills a rect with a horizontal linear gradient (endpoint colours + midpoint)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 1).getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 4, 0);   // left→right
      g.addColorStop(0, '#ff0000');
      g.addColorStop(1, '#0000ff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 1);
      const d = ctx.getImageData(0, 0, 4, 1);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    # Pixel centres at x=0.5,1.5,2.5,3.5 → t=0.125,0.375,0.625,0.875 of red→blue.
    expect(px[0][0]).to be > 200          # left: mostly red
    expect(px[0][2]).to be < 60
    expect(px[3][2]).to be > 200          # right: mostly blue
    expect(px[3][0]).to be < 60
    expect(px[1][0]).to be > px[2][0]     # red decreases left→right
    expect(px[1][2]).to be < px[2][2]     # blue increases left→right
    expect(px.all? {|p| p[3] == 255 }).to be true
  end

  it 'fillStyle round-trips a gradient object and reads it back' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 1, 0);
      ctx.fillStyle = g;
      JSON.stringify({ isSame: ctx.fillStyle === g, tag: Object.prototype.toString.call(ctx.fillStyle) });
    JS
    res = JSON.parse(out)
    expect(res['isSame']).to be true
    expect(res['tag']).to eq('[object CanvasGradient]')
  end

  it 'addColorStop throws on an out-of-range offset or invalid colour' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const g = new OffscreenCanvas(1, 1).getContext('2d').createLinearGradient(0, 0, 1, 0);
      const errs = {};
      try { g.addColorStop(2, 'red'); } catch (e) { errs.offset = e.name; }
      try { g.addColorStop(0.5, 'not-a-color'); } catch (e) { errs.color = e.name; }
      JSON.stringify(errs);
    JS
    errs = JSON.parse(out)
    expect(errs['offset']).to eq('IndexSizeError')
    expect(errs['color']).to eq('SyntaxError')
  end

  it 'radial gradient fills the inner disc with the start colour' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      const g = ctx.createRadialGradient(10, 10, 0, 10, 10, 10);
      g.addColorStop(0, '#ff0000');
      g.addColorStop(1, '#00ff00');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 20, 20);
      const d = ctx.getImageData(0, 0, 20, 20);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 20 + x] }
    centre = at.call(10, 10)
    edge   = at.call(10, 1)      # near radius 9 from centre → mostly green
    expect(centre[0]).to be > 200   # centre red-dominant
    expect(centre[1]).to be < 80
    expect(edge[1]).to be > edge[0] # outer ring green-dominant
  end

  it 'clip() masks subsequent fills to the clip region' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.beginPath();
      ctx.rect(1, 1, 2, 2);        // clip to the centre 2×2
      ctx.clip();
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 4, 4);    // paint the whole canvas — only the clip shows
      const d = ctx.getImageData(0, 0, 4, 4);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    at = ->(x, y) { px[y * 4 + x] }
    expect(at.call(1, 1)).to eq([255, 0, 0, 255])   # inside clip
    expect(at.call(2, 2)).to eq([255, 0, 0, 255])   # inside clip
    expect(at.call(0, 0)).to eq([0, 0, 0, 0])        # outside clip — untouched
    expect(at.call(3, 3)).to eq([0, 0, 0, 0])        # outside clip
  end

  it 'restore() lifts a clip set after save()' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, 1, 1); ctx.clip();
      ctx.restore();                // clip lifted
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 0, 4, 4);     // now fills the whole canvas
      const d = ctx.getImageData(0, 0, 4, 4);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px.all? {|p| p == [0, 0, 255, 255] }).to be true   # clip lifted → full fill
  end

  it 'throws TypeError for non-finite gradient coordinates' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      const errs = {};
      try { ctx.createLinearGradient(0, 0, Infinity, 0); } catch (e) { errs.linear = e.name; }
      try { ctx.createRadialGradient(NaN, 0, 1, 0, 0, 2); } catch (e) { errs.radial = e.name; }
      try { ctx.createRadialGradient(0, 0, -1, 0, 0, 2); } catch (e) { errs.neg = e.name; }
      JSON.stringify(errs);
    JS
    errs = JSON.parse(out)
    expect(errs['linear']).to eq('TypeError')
    expect(errs['radial']).to eq('TypeError')
    expect(errs['neg']).to eq('IndexSizeError')
  end

  it 'resizing a canvas resets the context state (transform + clip)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      const ctx = c.getContext('2d');
      ctx.translate(2, 2);
      ctx.beginPath(); ctx.rect(-2, -2, 1, 1); ctx.clip();
      c.width = 4;                          // resize → resets transform + clip
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 4, 4);             // identity transform, no clip → whole canvas
      const d = ctx.getImageData(0, 0, 4, 4);
      JSON.stringify(Array.from(d.data));
    JS
    px = JSON.parse(out).each_slice(4).to_a
    expect(px.all? {|p| p == [255, 0, 0, 255] }).to be true   # state reset → full red fill
  end

  it 'measureText returns real font metrics that scale with size and length' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      ctx.font = '10px sans-serif';
      const a = ctx.measureText('Hello');
      ctx.font = '20px sans-serif';
      const b = ctx.measureText('Hello');
      const c = ctx.measureText('Hello World');
      JSON.stringify({
        aw: a.width, bw: b.width, cw: c.width,
        hasMetrics: typeof b.fontBoundingBoxAscent === 'number' && b.fontBoundingBoxAscent > 0,
        emptyW: ctx.measureText('').width
      });
    JS
    r = JSON.parse(out)
    expect(r['aw']).to be > 0
    expect(r['bw']).to be > r['aw']          # 20px wider than 10px
    expect(r['cw']).to be > r['bw']          # longer string wider
    expect(r['hasMetrics']).to be true
    expect(r['emptyW']).to eq(0)
  end

  it 'fillText rasterizes real glyphs at the baseline anchor' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = new OffscreenCanvas(120, 40);
      const ctx = c.getContext('2d');
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#000000';
      ctx.fillText('Hi', 5, 25);            // alphabetic baseline at y=25
      const d = ctx.getImageData(0, 0, 120, 40).data;
      let painted = 0, minx = 999, maxx = 0, maxy = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) {
        if (d[(y * 120 + x) * 4 + 3] > 0) { painted++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
      }
      JSON.stringify({ painted, minx, maxx, maxy });
    JS
    r = JSON.parse(out)
    expect(r['painted']).to be > 20          # real glyph coverage, not blank
    expect(r['minx']).to be >= 4             # starts near the x=5 anchor
    expect(r['minx']).to be < 15
    expect(r['maxy']).to be <= 26            # ink sits above/at the baseline (no descender)
  end

  it 'fillText honors textAlign (right shifts the run left of the anchor)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      function run(align) {
        const ctx = new OffscreenCanvas(120, 40).getContext('2d');
        ctx.font = '20px sans-serif';
        ctx.textAlign = align;
        ctx.fillText('Hi', 60, 25);
        const d = ctx.getImageData(0, 0, 120, 40).data;
        let minx = 999, maxx = 0;
        for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++)
          if (d[(y * 120 + x) * 4 + 3] > 0) { if (x < minx) minx = x; if (x > maxx) maxx = x; }
        return { minx, maxx };
      }
      JSON.stringify({ left: run('left'), right: run('right') });
    JS
    r = JSON.parse(out)
    expect(r['left']['minx']).to be >= 59    # left-aligned: run starts at anchor x=60
    expect(r['right']['maxx']).to be <= 61   # right-aligned: run ends at anchor x=60
    expect(r['right']['minx']).to be < r['left']['minx']  # right-aligned run is left of the anchor
  end

  it 'fillText is masked by clip()' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(120, 40).getContext('2d');
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#000000';
      ctx.beginPath(); ctx.rect(0, 0, 20, 40); ctx.clip();  // only left 20px visible
      ctx.fillText('Hello World', 5, 25);
      const d = ctx.getImageData(0, 0, 120, 40).data;
      let maxx = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++)
        if (d[(y * 120 + x) * 4 + 3] > 0 && x > maxx) maxx = x;
      JSON.stringify({ maxx });
    JS
    expect(JSON.parse(out)['maxx']).to be < 20   # nothing painted past the clip
  end

  it 'renders text with markup metacharacters literally (no Pango markup)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(160, 40).getContext('2d');
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#000000';
      ctx.fillText('A < B & C', 5, 25);     // '<' and '&' would break Pango markup
      const d = ctx.getImageData(0, 0, 160, 40).data;
      let painted = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k] > 0) painted++;
      // measureText must also survive the metacharacters (non-zero width).
      JSON.stringify({ painted, w: ctx.measureText('A < B & C').width });
    JS
    r = JSON.parse(out)
    expect(r['painted']).to be > 20          # rendered, not silently dropped
    expect(r['w']).to be > 0
  end

  it 'maxWidth condenses the line horizontally onto one row (no wrap)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = new OffscreenCanvas(200, 40);
      const ctx = c.getContext('2d');
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#000000';
      const natural = ctx.measureText('Wide Text Here').width;
      ctx.fillText('Wide Text Here', 0, 25, 40);   // squeeze into 40px
      const d = ctx.getImageData(0, 0, 200, 40).data;
      let maxx = 0, maxy = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 200; x++)
        if (d[(y * 200 + x) * 4 + 3] > 0) { if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
      JSON.stringify({ natural, maxx, maxy });
    JS
    r = JSON.parse(out)
    expect(r['natural']).to be > 40          # naturally wider than the cap
    expect(r['maxx']).to be <= 41            # condensed to ~40px wide, not wrapped
    expect(r['maxy']).to be <= 30            # single row (no wrap spilling down)
  end

  it 'resolves em/rem font sizes against computed font-size (not a fixed 16px)' do
    app_fs = Rack::Builder.new {
      run lambda {|env|
        [200, {'content-type' => 'text/html'},
         ['<html style="font-size:40px"><body><canvas id="c" style="font-size:30px"></canvas></body></html>']]
      }
    }.to_app
    Capybara.app = app_fs
    session = simulated_session(app_fs)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = document.getElementById('c').getContext('2d');
      ctx.font = '1em sans-serif';    // → 30px (canvas element font-size)
      const em = ctx.measureText('MM').width;
      ctx.font = '30px sans-serif';   // reference: same size
      const px = ctx.measureText('MM').width;
      ctx.font = '1rem sans-serif';   // → 40px (root font-size)
      const rem = ctx.measureText('MM').width;
      JSON.stringify({ em, px, rem });
    JS
    r = JSON.parse(out)
    expect(r['em']).to eq(r['px'])           # 1em == the element's 30px font-size
    expect(r['rem']).to be > r['em']         # 1rem (40px root) is larger
  end

  it 'keeps a named family when the size unit is not px' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      ctx.font = 'bold 12pt monospace';   // pt unit + explicit family
      // A monospace 12pt run must have a non-zero, plausible width (family not lost).
      JSON.stringify({ w: ctx.measureText('abcd').width });
    JS
    expect(JSON.parse(out)['w']).to be > 0
  end

  it 'roundRect fills a rounded rectangle (corners clipped, interior filled)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.beginPath();
      ctx.roundRect(0, 0, 20, 20, 6);
      ctx.fill();
      const d = ctx.getImageData(0, 0, 20, 20).data;
      const at = (x, y) => d[(y * 20 + x) * 4 + 3];
      JSON.stringify({ corner: at(0, 0), center: at(10, 10), edgeMid: at(10, 0) });
    JS
    r = JSON.parse(out)
    expect(r['corner']).to eq(0)             # rounded corner is transparent
    expect(r['center']).to eq(255)           # interior filled
    expect(r['edgeMid']).to eq(255)          # straight edge midpoint filled
  end

  it 'roundRect rejects an out-of-range radii list' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      const errs = {};
      try { ctx.roundRect(0, 0, 10, 10, [1, 2, 3, 4, 5]); } catch (e) { errs.tooMany = e.name; }
      try { ctx.roundRect(0, 0, 10, 10, -2); } catch (e) { errs.negative = e.name; }
      JSON.stringify(errs);
    JS
    errs = JSON.parse(out)
    expect(errs['tooMany']).to eq('RangeError')
    expect(errs['negative']).to eq('RangeError')
  end

  it 'isPointInPath / isPointInStroke hit-test the current path' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, 0); ctx.lineTo(0, 10); ctx.closePath();
      const inTri = ctx.isPointInPath(2, 2), outTri = ctx.isPointInPath(8, 8);
      // even-odd hole
      ctx.beginPath(); ctx.rect(0, 0, 20, 20); ctx.rect(5, 5, 10, 10);
      const holeNZ = ctx.isPointInPath(10, 10, 'nonzero'), holeEO = ctx.isPointInPath(10, 10, 'evenodd');
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(20, 5);
      const onStroke = ctx.isPointInStroke(10, 5), offStroke = ctx.isPointInStroke(10, 15);
      JSON.stringify({ inTri, outTri, holeNZ, holeEO, onStroke, offStroke });
    JS
    r = JSON.parse(out)
    expect(r['inTri']).to be true
    expect(r['outTri']).to be false
    expect(r['holeNZ']).to be true          # nonzero: nested same-wound rects are solid
    expect(r['holeEO']).to be false         # even-odd: inner rect is a hole
    expect(r['onStroke']).to be true
    expect(r['offStroke']).to be false
  end

  it 'DOMMatrix composes transforms, inverts, and serialises' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ident = new DOMMatrix();
      const scaled = new DOMMatrix().scale(2, 3);
      const rot = new DOMMatrix().rotate(90);                 // degrees
      const inv = new DOMMatrix([2, 0, 0, 4, 10, 20]).inverse();
      const pt = new DOMMatrix().translate(3, 4).transformPoint({x: 1, y: 1});
      const multi = new DOMMatrix().rotate(90, 90, 0).transformPoint({x: 1, y: 0, z: 0});
      let stringifyThrew = null;
      try { new DOMMatrix([0, 0, 0, 0, 0, 0]).inverse().toString(); } catch (e) { stringifyThrew = e.name; }
      JSON.stringify({
        identity: ident.isIdentity && ident.is2D,
        f32: Array.from(scaled.toFloat32Array()),
        rot: [rot.a, rot.b, rot.c, rot.d].map(Math.round),
        inv: [inv.a, inv.d, inv.e, inv.f],
        pt: [pt.x, pt.y],
        multiRot: [multi.x, multi.y, multi.z].map(Math.round),   // Rz·Ry·Rx compose order
        str: new DOMMatrix('matrix(1, 2, 3, 4, 5, 6)').toString(),
        seq16NotFlat: new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).is2D,
        scale3dIs3D: new DOMMatrix().scale3d(2).is2D,
        infiniteOk: !isFinite(new DOMMatrix([Infinity, 0, 0, 1, 0, 0]).a),
        stringifyThrew
      });
    JS
    r = JSON.parse(out)
    expect(r['identity']).to be true
    expect(r['f32']).to eq([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(r['rot']).to eq([0, 1, -1, 0])                    # rotate 90°: a≈0, b=1, c=-1, d≈0
    expect(r['inv']).to eq([0.5, 0.25, -5, -5])
    expect(r['pt']).to eq([4, 5])
    expect(r['multiRot']).to eq([0, 0, -1])                  # matches Chromium/Firefox axis order
    expect(r['str']).to eq('matrix(1, 2, 3, 4, 5, 6)')
    expect(r['seq16NotFlat']).to be false                    # a 16-element ctor is 3D even when flat
    expect(r['scale3dIs3D']).to be false
    expect(r['infiniteOk']).to be true                       # unrestricted double: Infinity kept, not rejected
    expect(r['stringifyThrew']).to eq('InvalidStateError')   # non-finite serialisation throws
  end

  it 'ctx.getTransform reflects the CTM and setTransform accepts a DOMMatrix' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      ctx.scale(2, 3); ctx.translate(4, 5);
      const m = ctx.getTransform();
      ctx.setTransform(new DOMMatrix([1, 0, 0, 1, 7, 9]));   // matrix overload
      const after = ctx.getTransform();
      ctx.setTransform();                                    // no args → reset to identity
      const reset = ctx.getTransform().isIdentity;
      JSON.stringify({
        reflected: [m.a, m.d, m.e, m.f],                     // scale then translate
        isMatrix: m instanceof DOMMatrix,
        set: [after.a, after.e, after.f],
        reset
      });
    JS
    r = JSON.parse(out)
    expect(r['reflected']).to eq([2, 3, 8, 15])              # e = 2*4, f = 3*5
    expect(r['isMatrix']).to be true
    expect(r['set']).to eq([1, 7, 9])
    expect(r['reset']).to be true
  end

  it 'createConicGradient sweeps colour around the centre' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      const g = ctx.createConicGradient(0, 10, 10);
      g.addColorStop(0, '#ff0000');
      g.addColorStop(1, '#0000ff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 20, 20);
      const d = ctx.getImageData(0, 0, 20, 20).data;
      let painted = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k] > 0) painted++;
      JSON.stringify({ painted });
    JS
    expect(JSON.parse(out)['painted']).to eq(400)   # whole canvas painted by the sweep
  end

  it 'reset() clears the bitmap and resets context state' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.translate(2, 2);
      ctx.fillRect(-2, -2, 4, 4);
      ctx.reset();
      const cleared = Array.from(ctx.getImageData(0, 0, 4, 4).data).every(v => v === 0);
      // state reset: default black + identity transform
      const defFill = ctx.fillStyle;
      ctx.fillRect(0, 0, 4, 4);
      const filled = ctx.getImageData(0, 0, 4, 4).data;
      JSON.stringify({ cleared, defFill, tl: [filled[0], filled[1], filled[2], filled[3]] });
    JS
    r = JSON.parse(out)
    expect(r['cleared']).to be true
    expect(r['defFill']).to eq('#000000')
    expect(r['tl']).to eq([0, 0, 0, 255])   # black at (0,0) → identity transform restored
  end

  it 'roundRect collapses radii on a zero-dimension rect and no-ops a non-finite radius' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      // Non-finite radius → whole call is a no-op (path stays empty).
      ctx.beginPath();
      ctx.roundRect(0, 0, 20, 20, NaN);
      const emptyAfterNaN = !ctx.isPointInPath(10, 10);
      // Zero-width rect → radii collapse to 0 (no bulge outside the line).
      ctx.beginPath();
      ctx.roundRect(10, 0, 0, 20, 6);
      const noBulge = !ctx.isPointInPath(4, 10);   // 4px left of the zero-width line
      JSON.stringify({ emptyAfterNaN, noBulge });
    JS
    r = JSON.parse(out)
    expect(r['emptyAfterNaN']).to be true
    expect(r['noBulge']).to be true
  end

  it 'getContextAttributes reflects the options passed to getContext' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const a = new OffscreenCanvas(1, 1).getContext('2d', { alpha: false, willReadFrequently: true });
      const b = document.createElement('canvas').getContext('2d');   // defaults
      JSON.stringify({
        aAlpha: a.getContextAttributes().alpha, aWRF: a.getContextAttributes().willReadFrequently,
        bAlpha: b.getContextAttributes().alpha, bWRF: b.getContextAttributes().willReadFrequently
      });
    JS
    r = JSON.parse(out)
    expect(r['aAlpha']).to be false
    expect(r['aWRF']).to be true
    expect(r['bAlpha']).to be true          # default
    expect(r['bWRF']).to be false
  end

  it 'exposes the settings IDL properties (stored + save/restore)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      ctx.shadowBlur = 4; ctx.shadowColor = 'red'; ctx.lineDashOffset = 3;
      ctx.letterSpacing = '2px'; ctx.direction = 'rtl'; ctx.filter = 'blur(2px)';
      ctx.imageSmoothingQuality = 'high'; ctx.fontKerning = 'none';
      ctx.save();
      ctx.shadowBlur = 99; ctx.direction = 'ltr'; ctx.lineDashOffset = 0;
      ctx.restore();
      JSON.stringify({
        blur: ctx.shadowBlur, dir: ctx.direction, dash: ctx.lineDashOffset,
        ls: ctx.letterSpacing, filter: ctx.filter, quality: ctx.imageSmoothingQuality,
        kerning: ctx.fontKerning, attrs: ctx.getContextAttributes().alpha, lost: ctx.isContextLost()
      });
    JS
    r = JSON.parse(out)
    expect(r['blur']).to eq(4)               # restore() reverted the save()d change
    expect(r['dir']).to eq('rtl')
    expect(r['dash']).to eq(3)
    expect(r['ls']).to eq('2px')
    expect(r['filter']).to eq('blur(2px)')
    expect(r['quality']).to eq('high')
    expect(r['kerning']).to eq('none')
    expect(r['attrs']).to be true
    expect(r['lost']).to be false
  end

  it 'casts an offset drop shadow under a filled shape' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(30, 30).getContext('2d');
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowOffsetX = 8; ctx.shadowOffsetY = 8;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(2, 2, 8, 8);           // shape at (2,2)-(10,10); shadow at (10,10)-(18,18)
      const d = ctx.getImageData(0, 0, 30, 30).data;
      const at = (x, y) => Array.from(d.slice((y * 30 + x) * 4, (y * 30 + x) * 4 + 4));
      JSON.stringify({ shape: at(5, 5), shadow: at(14, 14), empty: at(25, 25) });
    JS
    r = JSON.parse(out)
    expect(r['shape']).to eq([255, 0, 0, 255])   # the actual red shape
    expect(r['shadow']).to eq([0, 0, 0, 204])    # offset shadow at 0.8 alpha (0.8×255)
    expect(r['empty']).to eq([0, 0, 0, 0])
  end

  it 'shadowBlur spreads the shadow beyond the shape bounds' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      function count(blur) {
        const ctx = new OffscreenCanvas(40, 40).getContext('2d');
        ctx.shadowColor = '#000000'; ctx.shadowBlur = blur;
        ctx.fillStyle = '#ff0000'; ctx.fillRect(15, 15, 10, 10);
        const d = ctx.getImageData(0, 0, 40, 40).data;
        let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
        return n;
      }
      JSON.stringify({ sharp: count(0), blurred: count(6) });
    JS
    r = JSON.parse(out)
    expect(r['sharp']).to eq(100)                # 10×10, no spread (offset 0, blur 0 → no shadow)
    expect(r['blurred']).to be > 150             # blur spreads well past the 100-px square
  end

  it 'clearRect casts no shadow' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(30, 30).getContext('2d');
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 30, 30);
      ctx.shadowColor = '#000000'; ctx.shadowOffsetX = 8; ctx.shadowOffsetY = 8;
      ctx.clearRect(2, 2, 8, 8);          // clear a hole — must NOT cast a shadow
      const d = ctx.getImageData(0, 0, 30, 30).data;
      const at = (x, y) => Array.from(d.slice((y * 30 + x) * 4, (y * 30 + x) * 4 + 4));
      JSON.stringify({ hole: at(5, 5), whereShadowWouldBe: at(14, 14) });
    JS
    r = JSON.parse(out)
    expect(r['hole']).to eq([0, 0, 0, 0])                  # cleared
    expect(r['whereShadowWouldBe']).to eq([0, 0, 255, 255]) # still blue — no shadow cast
  end

  it 'shadowColor parses, serialises, and resolves currentColor' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script("document.body.innerHTML = '<canvas id=cc width=10 height=10 style=\"color:#0f0\"></canvas>'")
    out = session.evaluate_script(<<~JS)
      const ctx = document.getElementById('cc').getContext('2d');
      ctx.shadowColor = 'lime';
      const named = ctx.shadowColor;
      ctx.shadowColor = 'RGBA(0,255, 0,0)';
      const rgba = ctx.shadowColor;
      ctx.shadowColor = '#00ff00';
      ctx.shadowColor = 'bogus';               // invalid → ignored
      const kept = ctx.shadowColor;
      ctx.shadowColor = 'currentColor';        // resolves to the canvas' computed color
      const current = ctx.shadowColor;
      JSON.stringify({ named, rgba, kept, current });
    JS
    r = JSON.parse(out)
    expect(r['named']).to eq('#00ff00')
    expect(r['rgba']).to eq('rgba(0, 255, 0, 0)')
    expect(r['kept']).to eq('#00ff00')
    expect(r['current']).to eq('#00ff00')
  end

  it 'casts a shadow from an off-canvas shape and weights it by source alpha' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(100, 50).getContext('2d');
      ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 100, 50);      // red backdrop
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';                     // 50%-alpha source
      ctx.shadowColor = '#00f';                                 // opaque blue shadow
      ctx.shadowOffsetY = 50;
      ctx.fillRect(0, -50, 100, 50);                            // drawn ABOVE the canvas
      const d = ctx.getImageData(50, 25, 1, 1).data;
      JSON.stringify(Array.from(d));
    JS
    r = JSON.parse(out)
    # off-canvas shape still casts (offset lands on-canvas); a 50%-alpha source
    # casts a 50% shadow → blue at 0.5 over red ≈ (127, 0, 127)
    expect(r[0]).to be_within(2).of(127)
    expect(r[1]).to eq(0)
    expect(r[2]).to be_within(2).of(127)
  end

  it 'composites the shadow with the current operator (xor)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(100, 50).getContext('2d');
      ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 100, 50);
      ctx.globalCompositeOperation = 'xor';
      ctx.shadowColor = '#f00'; ctx.shadowOffsetX = 100;
      ctx.fillStyle = '#0f0'; ctx.fillRect(-100, 0, 200, 50);
      const d = ctx.getImageData(50, 25, 1, 1).data;
      JSON.stringify(Array.from(d));
    JS
    r = JSON.parse(out)
    expect(r).to eq([0, 255, 0, 255])   # green survives the xor of red-shadow over red-bg
  end

  it 'loads an @font-face font for canvas text metrics (advance, ink box, em metrics)' do
    font     = File.binread(File.expand_path('wpt/fonts/CanvasTest.ttf', __dir__))
    face_app = Rack::Builder.new {
      run lambda {|env|
        if env['PATH_INFO'] == '/fonts/CanvasTest.ttf'
          [200, {'content-type' => 'font/ttf'}, [font]]
        else
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <!doctype html><meta charset=utf-8>
            <style>@font-face { font-family: CanvasTest; src: url("/fonts/CanvasTest.ttf"); }</style>
            <canvas id=c width=200 height=100></canvas>
          HTML
        end
      }
    }
    session = simulated_session(face_app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = document.getElementById('c').getContext('2d');
      ctx.font = '50px CanvasTest';
      const A = ctx.measureText('A'), D = ctx.measureText('D');
      // em metrics come from the font at 40px (typo asc:desc = 3:1 → 30/10)
      ctx.font = '40px CanvasTest';
      const em = ctx.measureText('A');
      JSON.stringify({
        ready:      typeof document.fonts.ready.then,   // FontFaceSet present
        advance:    A.width,                            // 1em advance = 50 (not the 127 ink)
        aRight:     A.actualBoundingBoxRight,
        aAscent:    Math.round(A.actualBoundingBoxAscent),
        dLeft:      Math.round(D.actualBoundingBoxLeft), // D has a ~50 left bearing
        emAscent:   em.emHeightAscent,
        emDescent:  em.emHeightDescent
      });
    JS
    r = JSON.parse(out)
    expect(r['ready']).to eq('function')
    expect(r['advance']).to eq(50)                 # hmtx advance, not the 127px ink width
    expect(r['aRight']).to be_within(1).of(50)
    expect(r['aAscent']).to be >= 35
    expect(r['dLeft']).to be_within(2).of(50)
    expect(r['emAscent']).to eq(30)
    expect(r['emDescent']).to eq(10)
  end

  it 'validates globalAlpha and supports the clear operator + whole-canvas ops' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      ctx.globalAlpha = 0.5;
      ctx.globalAlpha = 1.1; ctx.globalAlpha = -0.1; ctx.globalAlpha = Infinity; ctx.globalAlpha = NaN;
      const ga = ctx.globalAlpha;                       // all ignored → stays 0.5
      ctx.globalAlpha = 1;
      // 'clear' wipes only the source-COVERED region to transparent; the uncovered
      // destination is left intact (unlike copy / source-in).
      ctx.fillStyle = '#0ff'; ctx.fillRect(0, 0, 10, 10);
      ctx.globalCompositeOperation = 'clear'; ctx.fillRect(0, 0, 4, 4);
      const cleared   = ctx.getImageData(1, 1, 1, 1).data[3];   // inside the cleared rect
      const untouched = ctx.getImageData(8, 8, 1, 1).data[3];   // outside → still opaque
      // A blank canvas source under 'source-in' clears the destination it isn't covering.
      const ctx2 = new OffscreenCanvas(10, 10).getContext('2d');
      ctx2.fillStyle = '#f00'; ctx2.fillRect(0, 0, 10, 10);
      ctx2.globalCompositeOperation = 'source-in';
      ctx2.drawImage(new OffscreenCanvas(10, 10), 0, 0);   // blank source → all transparent
      const wiped = ctx2.getImageData(5, 5, 1, 1).data[3];
      JSON.stringify({ ga, cleared, untouched, wiped });
    JS
    r = JSON.parse(out)
    expect(r['ga']).to eq(0.5)
    expect(r['cleared']).to eq(0)
    expect(r['untouched']).to eq(255)   # 'clear' does NOT wipe the whole canvas
    expect(r['wiped']).to eq(0)
  end

  it 'drawImage: TypeError for a non-image, self-copy snapshots, blank/undrawn draws transparent' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 2).getContext('2d');
      let threw = null;
      try { ctx.drawImage({}, 0, 0); } catch (e) { threw = e.name; }
      // self-copy: shift the canvas onto itself by one row, reading original pixels.
      ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 4, 1);
      ctx.fillStyle = '#0f0'; ctx.fillRect(0, 1, 4, 1);
      ctx.drawImage(ctx.canvas, 0, -1);                 // row 1 (green) copied up to row 0
      const top = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      JSON.stringify({ threw, top });
    JS
    r = JSON.parse(out)
    expect(r['threw']).to eq('TypeError')
    expect(r['top']).to eq([0, 255, 0, 255])            # green from the self-copy, not corrupted
  end

  it 'fillStyle accepts colour objects, coerces via toString, and rejects bare hex' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(2, 2).getContext('2d');
      ctx.fillStyle = {r: 0, g: 1, b: 0, a: 0.5};        // colour object, components in [0,1]
      ctx.fillRect(0, 0, 2, 2);
      const obj = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      ctx.clearRect(0, 0, 2, 2);
      ctx.fillStyle = {r: 0, g: 1, b: 0, a: -1};         // alpha clamps to 0 → transparent
      ctx.fillRect(0, 0, 2, 2);
      const clamped = ctx.getImageData(0, 0, 1, 1).data[3];
      ctx.fillStyle = '#008000';
      ctx.fillStyle = { toString: () => '#0000ff' };     // toString → parsed as a colour
      const viaToString = ctx.fillStyle;
      ctx.fillStyle = {};                                // "[object Object]" → invalid → kept
      const keptObj = ctx.fillStyle;
      ctx.fillStyle = 800000;                            // "800000" (bare hex) → invalid → kept
      const keptNum = ctx.fillStyle;
      let threw = null;
      try { ctx.fillStyle = { toString() { throw new TypeError('x'); } }; } catch (e) { threw = e.name; }
      JSON.stringify({ obj, clamped, viaToString, keptObj, keptNum, threw });
    JS
    r = JSON.parse(out)
    expect(r['obj']).to eq([0, 255, 0, 128])           # 0.5 alpha over transparent
    expect(r['clamped']).to eq(0)
    expect(r['viaToString']).to eq('#0000ff')
    expect(r['keptObj']).to eq('#0000ff')              # invalid object ignored
    expect(r['keptNum']).to eq('#0000ff')              # bare-hex number ignored
    expect(r['threw']).to eq('TypeError')              # a throwing toString propagates
  end

  it 'gradient addColorStop validates the offset and resolves currentColor to black' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(4, 1).getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 4, 0);
      const err = (fn) => { try { fn(); return 'none'; } catch (e) { return e.name; } };
      const r = {
        neg: err(() => g.addColorStop(-1, '#000')),      // out of range → IndexSizeError
        big: err(() => g.addColorStop(2, '#000')),
        inf: err(() => g.addColorStop(Infinity, '#000')), // non-finite → TypeError
        nan: err(() => g.addColorStop(NaN, '#000')),
      };
      g.addColorStop(0, 'currentColor'); g.addColorStop(1, 'currentColor');   // → black
      ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 1);
      r.stop = Array.from(ctx.getImageData(2, 0, 1, 1).data);
      JSON.stringify(r);
    JS
    r = JSON.parse(out)
    expect(r['neg']).to eq('IndexSizeError')
    expect(r['big']).to eq('IndexSizeError')
    expect(r['inf']).to eq('TypeError')
    expect(r['nan']).to eq('TypeError')
    expect(r['stop']).to eq([0, 0, 0, 255])            # currentColor stop → opaque black
  end

  it 'parses CSS Color 4/5 (color(), color-mix, relative colour) and serialises color(srgb …)' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script("document.body.innerHTML = '<canvas id=cc width=4 height=4 style=\"color:#f0f\"></canvas>'")
    out = session.evaluate_script(<<~JS)
      const ctx = document.getElementById('cc').getContext('2d');
      const ser = (v) => { ctx.fillStyle = '#000'; ctx.fillStyle = v; return ctx.fillStyle; };
      JSON.stringify({
        colorFn:   ser('color(srgb 0.5 0 0.5)'),
        mix:       ser('color-mix(in srgb, red, blue)'),
        mixIdent:  ser('color-mix(in srgb, red, color(srgb 1 0 0))'),
        mixCur:    ser('color-mix(in srgb, black, currentcolor)'),   // currentcolor = #f0f
        relRgb:    ser('rgb(from red g r b)'),
        relColor:  ser('color(from color(srgb 0.25 0.5 0.75 / 0.5) srgb r g b / alpha)'),
        legacyHex: ser('red'),                                       // legacy stays hex
        badHex:    (ctx.fillStyle = '#0f0', ctx.fillStyle = '800000', ctx.fillStyle)  // bare hex invalid → kept green
      });
    JS
    r = JSON.parse(out)
    expect(r['colorFn']).to eq('color(srgb 0.5 0 0.5)')
    expect(r['mix']).to eq('color(srgb 0.5 0 0.5)')
    expect(r['mixIdent']).to eq('color(srgb 1 0 0)')
    expect(r['mixCur']).to eq('color(srgb 0.5 0 0.5)')              # black + magenta
    expect(r['relRgb']).to eq('color(srgb 0 1 0)')
    expect(r['relColor']).to eq('color(srgb 0.25 0.5 0.75 / 0.5)')
    expect(r['legacyHex']).to eq('#ff0000')
    expect(r['badHex']).to eq('#00ff00')
  end

  it 'roundRect ignores a non-finite radius but throws on a finite negative one' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(20, 20).getContext('2d');
      ctx.moveTo(0, 0); ctx.lineTo(10, 0);
      let threwInf = false, threwNaN = false, threwNeg = null;
      // non-finite radius (incl -Infinity) → no-op, must not throw or disturb the path
      try { ctx.roundRect(0, 0, 5, 5, [Infinity]); } catch (e) { threwInf = true; }
      try { ctx.roundRect(0, 0, 5, 5, [-Infinity]); } catch (e) { threwNaN = true; }
      try { ctx.roundRect(0, 0, 5, 5, [-3]); } catch (e) { threwNeg = e.name; }   // finite negative → throws
      // Winding: the SAME rect drawn once CW and once via a negative dimension (CCW)
      // cancels under nonzero winding, leaving the region unfilled.
      const ctx2 = new OffscreenCanvas(20, 20).getContext('2d');
      ctx2.fillStyle = '#0f0'; ctx2.fillRect(0, 0, 20, 20);
      ctx2.beginPath();
      ctx2.fillStyle = '#f00';
      ctx2.roundRect(0, 0, 20, 20, [0]);          // CW
      ctx2.roundRect(0, 20, 20, -20, [0]);        // negative height → same rect, CCW → cancels
      ctx2.fill();
      const cancelled = ctx2.getImageData(10, 10, 1, 1).data[1];   // green: fully cancelled
      JSON.stringify({ threwInf, threwNaN, threwNeg, cancelled });
    JS
    r = JSON.parse(out)
    expect(r['threwInf']).to be false
    expect(r['threwNaN']).to be false            # -Infinity is non-finite → ignored, not a RangeError
    expect(r['threwNeg']).to eq('RangeError')
    expect(r['cancelled']).to eq(255)            # negative-dim rect reversed the winding → cancelled
  end

  it 'throws TypeError for too few arguments (WebIDL arity)' do
    session = simulated_session(app)
    session.visit('/')
    session.execute_script("document.body.innerHTML = '<canvas id=cc width=10 height=10></canvas>'")
    out = session.evaluate_script(<<~JS)
      const canvas = document.getElementById('cc');
      const ctx = canvas.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 10, 0);
      const err = (fn) => { try { fn(); return 'none'; } catch (e) { return e.name; } };
      JSON.stringify({
        getContext:  err(() => canvas.getContext()),         // required arg
        scale:       err(() => ctx.scale(1)),                // needs 2
        fillRect:    err(() => ctx.fillRect(0, 0, 5)),       // needs 4
        arc:         err(() => ctx.arc(0, 0, 1, 0)),         // needs 5
        setTransform3: err(() => ctx.setTransform(1, 0, 0)), // 2–5 args → TypeError
        setTransform1: err(() => ctx.setTransform(1)),       // 1 non-object → TypeError
        addColorStop: err(() => g.addColorStop(0)),          // missing color → TypeError (not SyntaxError)
        drawImage:   err(() => ctx.drawImage(canvas, 0)),    // needs 3
        // valid calls must NOT throw
        okReset:     err(() => ctx.setTransform()),          // 0 args → identity reset
        okFillRect:  err(() => ctx.fillRect(0, 0, 5, 5)),
      });
    JS
    r = JSON.parse(out)
    %w[getContext scale fillRect arc setTransform3 setTransform1 addColorStop drawImage].each do |m|
      expect(r[m]).to eq('TypeError'), "#{m} should throw TypeError, got #{r[m]}"
    end
    expect(r['okReset']).to eq('none')
    expect(r['okFillRect']).to eq('none')
  end

  it 'reports context creation attributes via getContextAttributes' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const mk = (o) => new OffscreenCanvas(1, 1).getContext('2d', o).getContextAttributes();
      JSON.stringify({
        defaults: mk({}),
        custom:   mk({alpha: false, colorSpace: 'display-p3', colorType: 'float16', willReadFrequently: true}),
      });
    JS
    r = JSON.parse(out)
    expect(r['defaults']).to eq(
      'alpha'              => true,
      'desynchronized'     => false,
      'colorSpace'         => 'srgb',
      'colorType'          => 'unorm8',
      'willReadFrequently' => false
    )
    expect(r['custom']).to include(
      'alpha'              => false,
      'colorSpace'         => 'display-p3',
      'colorType'          => 'float16',
      'willReadFrequently' => true
    )
  end

  it 'bilinearly interpolates a scaled drawImage only when imageSmoothingEnabled' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      // 2×2 source: (0,0) green, the other three red.
      const src = new OffscreenCanvas(2, 2).getContext('2d');
      src.fillStyle = '#f00'; src.fillRect(0, 0, 2, 2);
      src.fillStyle = '#0f0'; src.fillRect(0, 0, 1, 1);
      const px = (smooth) => {
        const ctx = new OffscreenCanvas(20, 20).getContext('2d');
        ctx.imageSmoothingEnabled = smooth;
        ctx.scale(10, 10);
        ctx.drawImage(src.canvas, 0, 0);
        return [...ctx.getImageData(9, 9, 1, 1).data];   // interior, near the green/red seam
      };
      JSON.stringify({ smooth: px(true), nearest: px(false) });
    JS
    r = JSON.parse(out)
    # Smoothing off → nearest-neighbour: device (9,9) maps to source (0,0), pure green.
    expect(r['nearest']).to eq([0, 255, 0, 255])
    # Smoothing on → the sample sits near the green/red seam, so red bleeds in: it is
    # neither pure green nor pure red.
    expect(r['smooth'][0]).to be > 0        # some red bled in
    expect(r['smooth'][1]).not_to eq(255)   # not fully green anymore
    expect(r['smooth'][1]).to be > 0        # but still some green
    expect(r['smooth'][3]).to eq(255)       # opaque edge stays opaque (clamp-to-edge)
  end

  it 'does not bleed adjacent atlas cells when smoothing a scaled sub-rect' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      // 2×1 atlas: left cell green, right cell red.
      const atlas = new OffscreenCanvas(2, 1).getContext('2d');
      atlas.fillStyle = '#0f0'; atlas.fillRect(0, 0, 1, 1);
      atlas.fillStyle = '#f00'; atlas.fillRect(1, 0, 1, 1);
      const ctx = new OffscreenCanvas(10, 1).getContext('2d');
      ctx.imageSmoothingEnabled = true;
      // Draw ONLY the green cell (source sub-rect 0,0,1,1) magnified 10×.
      ctx.drawImage(atlas.canvas, 0, 0, 1, 1, 0, 0, 10, 1);
      JSON.stringify([...ctx.getImageData(9, 0, 1, 1).data]);   // rightmost drawn pixel
    JS
    # The neighbouring red cell must not bleed across the sub-rect seam: the whole
    # magnified cell stays pure green (clamp-to-sub-rect, not clamp-to-image).
    expect(JSON.parse(out)).to eq([0, 255, 0, 255])
  end

  it 'counts points exactly on the fill boundary as inside (isPointInPath)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(30, 30).getContext('2d');
      ctx.rect(0, 0, 20, 20);
      const on  = [[0, 0], [10, 0], [20, 0], [20, 10], [20, 20], [10, 20], [0, 20], [0, 10]];
      const off = [[10, -0.01], [10, 20.01], [-0.01, 10], [20.01, 10]];
      const onR  = on.map(([x, y]) => ctx.isPointInPath(x, y));
      const offR = off.map(([x, y]) => ctx.isPointInPath(x, y));
      // A non-invertible CTM maps the plane to a point → nothing is inside. (beginPath
      // here replaces the current path — it isn't part of the save/restore state.)
      ctx.scale(0, 0); ctx.beginPath(); ctx.rect(-10, -10, 20, 20);
      const degenerate = ctx.isPointInPath(0, 0);
      JSON.stringify({ on: onR, off: offR, degenerate });
    JS
    r = JSON.parse(out)
    expect(r['on']).to all(eq(true))     # every boundary point is inside
    expect(r['off']).to all(eq(false))   # a hair outside is not
    expect(r['degenerate']).to eq(false) # non-invertible CTM → false
  end

  it 'does not count a point on a zero-area subpath as inside (isPointInPath)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(120, 20).getContext('2d');
      // A bare line and a repeated point enclose no area → fill paints nothing, so a
      // point lying on them is NOT inside (the edge-inclusion rule is only for the
      // boundary of a real filled region).
      ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(100, 10);
      const online = ctx.isPointInPath(50, 10);
      ctx.beginPath(); ctx.moveTo(50, 10); ctx.lineTo(50, 10);
      const onPoint = ctx.isPointInPath(50, 10);
      JSON.stringify({ online, onPoint });
    JS
    r = JSON.parse(out)
    expect(r['online']).to eq(false)
    expect(r['onPoint']).to eq(false)
  end

  it 'returns null for createPattern from a video with no decoded frame' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      const v = document.createElement('video');   // readyState HAVE_NOTHING → "bad" usability
      const err = (fn) => { try { return String(fn()); } catch (e) { return e.name; } };
      JSON.stringify({ pattern: err(() => ctx.createPattern(v, 'repeat')) });
    JS
    expect(JSON.parse(out)['pattern']).to eq('null')
  end

  it 'draws a focus ring only when the fallback element is focused (drawFocusIfNeeded)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      document.body.innerHTML =
        "<canvas id='c' width='100' height='100'><a href='#' id='el'>focus</a></canvas>";
      const canvas = document.getElementById('c');
      const el = document.getElementById('el');
      const ctx = canvas.getContext('2d');
      const draw = () => {
        ctx.clearRect(0, 0, 100, 100);
        ctx.beginPath(); ctx.rect(10, 10, 80, 80);
        ctx.drawFocusIfNeeded(el);
        const d = ctx.getImageData(0, 0, 100, 100).data;
        let painted = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) painted++;
        return painted;
      };
      const blurred = draw();     // el not focused → no ring
      el.focus();
      const focused = draw();     // el focused → ring painted
      // The focus ring is a UA decoration: globalAlpha=0 must not suppress it, and a
      // whole-canvas operator ('copy') must not let it erase existing canvas content.
      ctx.globalAlpha = 0;
      const underAlpha0 = draw();
      ctx.globalAlpha = 1;
      // The author's dash pattern must not dash the ring: same painted count as solid.
      ctx.setLineDash([2, 20]);
      const underDash = draw();
      ctx.setLineDash([]);
      ctx.fillStyle = '#00f'; ctx.fillRect(0, 0, 100, 100);
      ctx.globalCompositeOperation = 'copy';
      ctx.beginPath(); ctx.rect(10, 10, 80, 80);
      ctx.drawFocusIfNeeded(el);
      const bluePreserved = ctx.getImageData(0, 0, 1, 1).data[2];   // corner still blue?
      const err = (fn) => { try { fn(); return 'none'; } catch (e) { return e.name; } };
      JSON.stringify({
        blurred,
        focused,
        underAlpha0,
        underDash,
        bluePreserved,
        noArg:   err(() => ctx.drawFocusIfNeeded()),   // WebIDL: element required
        badArg:  err(() => ctx.drawFocusIfNeeded('nope')),
      });
    JS
    r = JSON.parse(out)
    expect(r['blurred']).to eq(0)          # unfocused → nothing drawn
    expect(r['focused']).to be > 0         # focused → a ring appears
    expect(r['underAlpha0']).to be > 0     # globalAlpha=0 does not suppress the ring
    expect(r['underDash']).to eq(r['focused'])  # author dash does not dash the ring
    expect(r['bluePreserved']).to eq(255)  # 'copy' op does not erase the canvas
    expect(r['noArg']).to eq('TypeError')
    expect(r['badArg']).to eq('TypeError')
  end

  it 'does not let a thick arc stroke overshoot its endpoint into the wrong half' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(100, 50).getContext('2d');
      ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 100, 50);
      ctx.lineWidth = 50; ctx.strokeStyle = '#f00';
      // A semicircle over the lower (off-canvas) half: nothing red should reach the
      // upper half. The end caps at (0,50)/(100,50) must hug the true tangent, not tilt.
      ctx.beginPath(); ctx.arc(50, 50, 50, 0, Math.PI, false); ctx.stroke();
      const pts = [[20, 48], [50, 25], [1, 1], [98, 1], [80, 48]];
      JSON.stringify(pts.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[0]));   // red channel
    JS
    # Every sampled point in the wrong (upper) half stays pure green — no red bleed.
    expect(JSON.parse(out)).to all(eq(0))
  end

  it 'ignores invalid text drawing-state values (enums / lengths)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      const probe = (prop, good, bads) => {
        ctx[prop] = good;
        return bads.map((b) => { ctx[prop] = b; return ctx[prop]; });
      };
      JSON.stringify({
        align:    probe('textAlign', 'start', ['bogus', 'END', 'end ', 'end\\0']),
        baseline: probe('textBaseline', 'top', ['bogus', 'MIDDLE', 'middle ', 'middle\\0']),
        direction: probe('direction', 'ltr', ['LTR', 'rtl ', 'rtl\\0', 'bogus']),
        letter:   probe('letterSpacing', '0px', ['0s', '1min', '1deg', 'normal', 'initial', NaN, Infinity]),
        word:     probe('wordSpacing', '0px', ['1pp', 'none', 'inherit', -Infinity]),
        okLetter: (ctx.letterSpacing = '3px', ctx.letterSpacing),   // a valid length IS accepted
      });
    JS
    r = JSON.parse(out)
    expect(r['align']).to all(eq('start'))
    expect(r['baseline']).to all(eq('top'))
    expect(r['direction']).to all(eq('ltr'))
    expect(r['letter']).to all(eq('0px'))
    expect(r['word']).to all(eq('0px'))
    expect(r['okLetter']).to eq('3px')
  end

  it 'draws nothing when fillText is given a non-positive or NaN maxWidth' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const painted = (maxWidth) => {
        const ctx = new OffscreenCanvas(120, 40).getContext('2d');
        ctx.font = '20px sans-serif'; ctx.fillStyle = '#f00';
        maxWidth === undefined ? ctx.fillText('hello', 5, 25) : ctx.fillText('hello', 5, 25, maxWidth);
        const d = ctx.getImageData(0, 0, 120, 40).data;
        let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
        return n;
      };
      JSON.stringify({ zero: painted(0), negative: painted(-1), nan: painted(NaN), omitted: painted(undefined) });
    JS
    r = JSON.parse(out)
    expect(r['zero']).to eq(0)         # maxWidth 0 → nothing drawn
    expect(r['negative']).to eq(0)     # maxWidth < 0 → nothing drawn
    expect(r['nan']).to eq(0)          # maxWidth NaN → nothing drawn
    expect(r['omitted']).to be > 0     # omitted maxWidth → text drawn normally
  end

  it 'canonically serializes the font shorthand and ignores invalid values' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');   // detached ⇒ em/% base 10px
      const set = (v) => { ctx.font = v; return ctx.font; };
      const keepAfter = (bad) => { ctx.font = '20px serif'; ctx.font = bad; return ctx.font; };
      JSON.stringify({
        plain:    set('20px serif'),
        caseWs:   set('20PX   SERIF'),
        reorder:  set('small-caps italic 400 12px/2 Unknown Font, sans-serif'),
        weight:   set('italic 300 12px serif'),
        weight400:set('italic 400 12px serif'),
        em:       set('2em sans-serif'),
        percent:  set('1000% serif'),
        invalids: ['', 'bogus', 'inherit', '10px initial', 'var(--x)', '12px'].map(keepAfter),
      });
    JS
    r = JSON.parse(out)
    expect(r['plain']).to eq('20px serif')
    expect(r['caseWs']).to eq('20px serif')                      # unit + generic family lower-cased, ws collapsed
    expect(r['reorder']).to eq('italic small-caps 12px Unknown Font, sans-serif')  # reorder, drop 400 + /2 (identifier run stays unquoted)
    expect(r['weight']).to eq('italic 300 12px serif')
    expect(r['weight400']).to eq('italic 12px serif')            # default weight dropped
    expect(r['em']).to eq('20px sans-serif')                     # 2em × 10px
    expect(r['percent']).to eq('100px serif')                    # 1000% × 10px
    expect(r['invalids']).to all(eq('20px serif'))              # every invalid keeps the previous
  end

  it 'renders a numeric-weight font at its size, not the weight value' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const inkHeight = (font) => {
        const ctx = new OffscreenCanvas(400, 120).getContext('2d');
        ctx.font = font; ctx.fillStyle = '#000'; ctx.fillText('Mg', 10, 60);
        const d = ctx.getImageData(0, 0, 400, 120).data;
        let lo = 999, hi = -1;
        for (let y = 0; y < 120; y++) for (let x = 0; x < 400; x++) {
          if (d[(y * 400 + x) * 4 + 3] > 0) { if (y < lo) lo = y; if (y > hi) hi = y; }
        }
        return hi - lo;
      };
      // The canonical form is '700 16px sans-serif' (weight before size); the renderer
      // must not mistake the leading '700' for the pixel size.
      JSON.stringify({ weighted: inkHeight('700 16px sans-serif'), plain: inkHeight('16px sans-serif') });
    JS
    r = JSON.parse(out)
    expect(r['plain']).to be_between(8, 30)             # ~16px text
    expect((r['weighted'] - r['plain']).abs).to be <= 2 # weighted renders at the same size
  end

  it 'reflects letter/word spacing in measureText width (resolved against the current font)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(400, 60).getContext('2d');
      ctx.font = '10px sans-serif';
      const w = (t) => ctx.measureText(t).width;
      const base = w('Hello World');                 // 11 chars, 1 space
      ctx.letterSpacing = '3px';
      const letter3 = w('Hello World') - base;        // +3 × 11
      ctx.letterSpacing = '0px';
      ctx.wordSpacing = '5px';
      const word5 = w('Hello World') - base;          // +5 × 1 space
      ctx.wordSpacing = '0px';
      ctx.letterSpacing = '1em';                       // em against the current font size (10px)
      const em10 = w('Hello World') - base;            // +10 × 11
      ctx.font = '20px sans-serif';                     // re-resolves the em spacing to 20px
      const base20 = ctx.measureText('Hello World').width;
      ctx.letterSpacing = '0px';
      const em20 = base20 - ctx.measureText('Hello World').width;   // +20 × 11 minus the 0-spacing width
      JSON.stringify({ letter3, word5, em10, em20 });
    JS
    r = JSON.parse(out)
    expect(r['letter3']).to be_within(0.1).of(33)    # 3px × 11 chars
    expect(r['word5']).to be_within(0.1).of(5)       # 5px × 1 space
    expect(r['em10']).to be_within(0.1).of(110)      # 1em(=10px) × 11
    expect(r['em20']).to be_within(0.1).of(220)      # 1em now 20px × 11
  end

  it 'validates fontStretch / fontVariantCaps / textRendering enum values' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(10, 10).getContext('2d');
      const probe = (prop, good, bads) => {
        ctx[prop] = good;
        return bads.map((b) => { ctx[prop] = b; return ctx[prop]; });
      };
      JSON.stringify({
        stretch: probe('fontStretch', 'ultra-expanded', ['Expanded', 'eXtra-expanded', 'abcd']),
        variant: probe('fontVariantCaps', 'small-caps', ['nORmal', 'small-CAPS', 'abcd']),
        render:  probe('textRendering', 'optimizeSpeed', ['Auto', 'normal', '', 'abcd']),
      });
    JS
    r = JSON.parse(out)
    expect(r['stretch']).to all(eq('ultra-expanded'))   # invalid ignored, keeps last valid
    expect(r['variant']).to all(eq('small-caps'))
    expect(r['render']).to all(eq('optimizeSpeed'))
  end

  it 'measures the bounding box relative to the text-alignment / direction origin' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(200, 40).getContext('2d');
      ctx.font = '20px sans-serif';
      const box = () => { const m = ctx.measureText('hello'); return m.actualBoundingBoxLeft - m.actualBoundingBoxRight; };
      ctx.textAlign = 'left';   const left  = box();   // origin at left edge → Left < Right (negative)
      ctx.textAlign = 'right';  const right = box();   // origin at right edge → Left > Right (positive)
      ctx.textAlign = 'start';  ctx.direction = 'ltr'; const startLtr = box();
      ctx.direction = 'rtl'; const startRtl = box();   // start with rtl aligns to the right edge
      JSON.stringify({ left, right, startLtr, startRtl });
    JS
    r = JSON.parse(out)
    expect(r['left']).to be < 0        # left-aligned: box extends right of the origin
    expect(r['right']).to be > 0       # right-aligned: box extends left of the origin
    expect(r['startLtr']).to be < 0    # start+ltr == left
    expect(r['startRtl']).to be > 0    # start+rtl == right
  end

  it 'normalizes tab/newline/CR/FF to spaces in text (single-line, no wrap)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(300, 80).getContext('2d');
      ctx.font = '20px sans-serif';
      const w = (t) => ctx.measureText(t).width;
      // Each control char measures like a space, and a newline does not wrap to a
      // second line (which would collapse the horizontal advance).
      const spaced = w('A B');
      JSON.stringify({
        tab: w('A\\tB'), lf: w('A\\nB'), cr: w('A\\rB'), ff: w('A\\fB'), spaced,
      });
    JS
    r = JSON.parse(out)
    %w[tab lf cr ff].each do |k|
      expect(r[k]).to be_within(0.5).of(r['spaced']), "#{k} should measure like 'A B'"
    end
  end

  it 'reports BASE-table baselines and positions ideographic-baseline text' do
    canvas_font = File.binread(File.expand_path('spec/wpt/fonts/CanvasTest.ttf', Dir.pwd))
    app = Rack::Builder.new {
      run lambda {|env|
        if Rack::Request.new(env).path_info.end_with?('.ttf')
          [200, {'content-type' => 'font/ttf'}, [canvas_font]]
        else
          [200, {'content-type' => 'text/html'}, [
            %q(<!doctype html><style>@font-face{font-family:CanvasTest;src:url('/CanvasTest.ttf')}</style>) +
            %q(<canvas id=c width=100 height=50></canvas>)
          ]]
        end
      }
    }.to_app
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = document.getElementById('c').getContext('2d');
      ctx.font = '50px CanvasTest';
      const m = ctx.measureText('A');
      // Draw CanvasTest 'CC' (opaque em blocks) with the ideographic baseline at y=31.25;
      // sample a pixel that must be covered when the baseline is placed correctly.
      ctx.textBaseline = 'ideographic'; ctx.fillStyle = '#00f';
      ctx.fillText('CC', 0, 31.25);
      const covered = ctx.getImageData(25, 25, 1, 1).data[3] > 0;
      JSON.stringify({
        alpha: m.alphabeticBaseline, hang: m.hangingBaseline, ideo: m.ideographicBaseline, covered,
      });
    JS
    r = JSON.parse(out)
    expect(r['alpha']).to eq(0)         # BASE romn baseline
    expect(r['hang']).to eq(25)         # 512 units × 50 / 1024
    expect(r['ideo']).to eq(6.25)       # 128 units × 50 / 1024
    expect(r['covered']).to eq(true)    # ideographic-baseline text lands where expected
  end

  it 'reflects fontKerning and small-caps in measureText width' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(400, 60).getContext('2d');
      ctx.font = '40px sans-serif';
      const wKern = ctx.measureText('TAWATAVA').width;
      ctx.fontKerning = 'none';
      const wNone = ctx.measureText('TAWATAVA').width;
      const kernValid = ctx.fontKerning === 'none';
      ctx.fontKerning = 'BOGUS';                 // invalid → ignored, keeps 'none'
      const kernIgnored = ctx.fontKerning;
      // small-caps via the font shorthand changes the measured width vs normal caps.
      ctx.font = 'small-caps 32px serif'; const wSmall = ctx.measureText('Hello World').width;
      ctx.font = '32px serif';            const wNorm  = ctx.measureText('Hello World').width;
      JSON.stringify({ wKern, wNone, kernValid, kernIgnored, wSmall, wNorm });
    JS
    r = JSON.parse(out)
    expect(r['wNone']).to be > r['wKern']    # disabling kerning widens the run
    expect(r['kernValid']).to eq(true)
    expect(r['kernIgnored']).to eq('none')   # invalid value ignored
    expect(r['wSmall']).not_to eq(r['wNorm']) # small-caps differs from normal
  end

  it "defaults ctx.lang to 'inherit' and resolves em/lh font sizes against the canvas element" do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      document.body.innerHTML = "<canvas id='c' width='100' height='50' style='font-size: 30px; line-height: 40px'></canvas>";
      const ctx = document.getElementById('c').getContext('2d');
      const lang = ctx.lang;
      ctx.font = '2em serif';   const em = ctx.font;    // 2 × 30px
      ctx.font = '2lh/100 serif'; const lh = ctx.font;  // 2 × 40px (line-height); /100 dropped
      JSON.stringify({ lang, em, lh });
    JS
    r = JSON.parse(out)
    expect(r['lang']).to eq('inherit')
    expect(r['em']).to eq('60px serif')
    expect(r['lh']).to eq('80px serif')
  end

  it 'fillText casts a shadow' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      function paintedCount(shadow) {
        const ctx = new OffscreenCanvas(120, 40).getContext('2d');
        ctx.font = '20px sans-serif'; ctx.fillStyle = '#ff0000';
        if (shadow) { ctx.shadowColor = '#000000'; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3; }
        ctx.fillText('Hi', 5, 25);
        const d = ctx.getImageData(0, 0, 120, 40).data;
        let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
        return n;
      }
      JSON.stringify({ plain: paintedCount(false), shadowed: paintedCount(true) });
    JS
    r = JSON.parse(out)
    expect(r['shadowed']).to be > r['plain']     # shadow adds painted pixels
  end

  it 'ignores negative / non-finite shadow values (no hang, no wipe)' do
    session = simulated_session(app)
    session.visit('/')
    out = Timeout.timeout(15) do
      session.evaluate_script(<<~JS)
        const ctx = new OffscreenCanvas(20, 20).getContext('2d');
        ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 20, 20);   // blue base
        ctx.shadowColor = '#000000'; ctx.shadowBlur = 5;
        ctx.shadowBlur = Infinity;                                // ignored (would hang)
        const afterInf = ctx.shadowBlur;
        ctx.shadowBlur = NaN; ctx.shadowBlur = -3;                // ignored (would wipe / invalid)
        const afterBad = ctx.shadowBlur;
        ctx.shadowOffsetX = NaN;                                  // ignored (offsets keep prior)
        const offX = ctx.shadowOffsetX;
        ctx.fillStyle = '#ff0000'; ctx.fillRect(4, 4, 4, 4);      // draws with the valid blur=5
        const corner = Array.from(ctx.getImageData(18, 1, 1, 1).data);  // still blue → not wiped
        JSON.stringify({ afterInf, afterBad, offX, corner });
      JS
    end
    r = JSON.parse(out)
    expect(r['afterInf']).to eq(5)           # Infinity ignored, prior kept
    expect(r['afterBad']).to eq(5)           # NaN and negative ignored
    expect(r['offX']).to eq(0)               # NaN offset ignored
    expect(r['corner']).to eq([0, 0, 255, 255])   # canvas not wiped
  end

  it 'composites with destination-out (erasing), lighter (additive), and multiply' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      // destination-out: the new shape erases the existing pixels it covers.
      const e = new OffscreenCanvas(10, 10).getContext('2d');
      e.fillStyle = '#0000ff'; e.fillRect(0, 0, 10, 10);
      e.globalCompositeOperation = 'destination-out';
      e.fillStyle = '#000000'; e.fillRect(0, 0, 5, 10);
      // lighter: red + green = yellow (additive).
      const l = new OffscreenCanvas(10, 10).getContext('2d');
      l.fillStyle = '#ff0000'; l.fillRect(0, 0, 10, 10);
      l.globalCompositeOperation = 'lighter';
      l.fillStyle = '#00ff00'; l.fillRect(0, 0, 10, 10);
      // multiply blend.
      const m = new OffscreenCanvas(10, 10).getContext('2d');
      m.fillStyle = '#ff8080'; m.fillRect(0, 0, 10, 10);
      m.globalCompositeOperation = 'multiply';
      m.fillStyle = '#8080ff'; m.fillRect(0, 0, 10, 10);
      JSON.stringify({ erased: px(e, 2, 2), kept: px(e, 7, 2), lit: px(l, 5, 5), mul: px(m, 5, 5) });
    JS
    r = JSON.parse(out)
    expect(r['erased']).to eq([0, 0, 0, 0])          # covered pixels erased
    expect(r['kept']).to eq([0, 0, 255, 255])        # uncovered pixels kept
    expect(r['lit']).to eq([255, 255, 0, 255])       # red + green
    expect(r['mul']).to eq([128, 64, 128, 255])      # 255·128/255, 128·128/255, 128·255/255
  end

  it 'composites source-atop (source shows only over existing pixels)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const ctx = new OffscreenCanvas(20, 10).getContext('2d');
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 10, 10);   // blue backdrop, left half only
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#ff0000'; ctx.fillRect(5, 0, 10, 10);   // red spanning (5..15)
      JSON.stringify({ overBlue: px(ctx, 7, 5), overEmpty: px(ctx, 12, 5), onlyBlue: px(ctx, 2, 5) });
    JS
    r = JSON.parse(out)
    expect(r['overBlue']).to eq([255, 0, 0, 255])    # red shows atop the blue
    expect(r['overEmpty']).to eq([0, 0, 0, 0])        # red over empty → nothing (no backdrop)
    expect(r['onlyBlue']).to eq([0, 0, 255, 255])     # blue where red didn't reach
  end

  it 'composites the whole-canvas operators (copy / source-in / destination-in), clearing uncovered' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      function run(op) {
        const c = new OffscreenCanvas(10, 10).getContext('2d');
        c.fillStyle = '#0000ff'; c.fillRect(0, 0, 10, 10);   // destination = blue everywhere
        c.globalCompositeOperation = op;
        c.fillStyle = '#ff0000'; c.fillRect(0, 0, 5, 10);     // source = red left half
        return { left: px(c, 2, 2), right: px(c, 7, 2) };
      }
      JSON.stringify({ copy: run('copy'), sin: run('source-in'), din: run('destination-in') });
    JS
    r = JSON.parse(out)
    expect(r['copy']['left']).to eq([255, 0, 0, 255])   # copy → source
    expect(r['copy']['right']).to eq([0, 0, 0, 0])       # uncovered CLEARED
    expect(r['sin']['left']).to eq([255, 0, 0, 255])    # source shown where dest exists
    expect(r['sin']['right']).to eq([0, 0, 0, 0])
    expect(r['din']['left']).to eq([0, 0, 255, 255])    # dest kept where source exists
    expect(r['din']['right']).to eq([0, 0, 0, 0])
  end

  it 'ignores an unknown globalCompositeOperation (keeps the previous)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      const def = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalCompositeOperation = 'bogus';        // invalid → ignored
      JSON.stringify({ def, after: ctx.globalCompositeOperation });
    JS
    r = JSON.parse(out)
    expect(r['def']).to eq('source-over')
    expect(r['after']).to eq('multiply')
  end

  it 'fills / strokes / clips / hit-tests a Path2D built from methods' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const at = (ctx, x, y) => ctx.getImageData(x, y, 1, 1).data[3];
      const p = new Path2D();
      p.moveTo(0, 0); p.lineTo(10, 0); p.lineTo(0, 10); p.closePath();
      const c = new OffscreenCanvas(12, 12).getContext('2d');
      c.fillStyle = '#ff0000'; c.fill(p);
      const triIn = at(c, 2, 2), triOut = at(c, 8, 8);
      const hit = c.isPointInPath(p, 2, 2), miss = c.isPointInPath(p, 8, 8);
      // stroke(path) + clip(path)
      const box = new Path2D(); box.rect(2, 2, 8, 8);
      const cc = new OffscreenCanvas(12, 12).getContext('2d');
      cc.beginPath(); cc.rect(0, 0, 6, 12); cc.clip();     // current-path clip still works
      cc.fillStyle = '#0000ff'; cc.fill(box);              // fill a Path2D, masked by the clip
      const clipped = at(cc, 8, 5), visible = at(cc, 4, 5);
      JSON.stringify({ triIn, triOut, hit, miss, clipped, visible,
                       isP2D: (new Path2D()) instanceof Path2D });
    JS
    r = JSON.parse(out)
    expect(r['triIn']).to eq(255)
    expect(r['triOut']).to eq(0)
    expect(r['hit']).to be true
    expect(r['miss']).to be false
    expect(r['clipped']).to eq(0)        # Path2D fill is masked by the current clip
    expect(r['visible']).to eq(255)
    expect(r['isP2D']).to be true
  end

  it 'parses a Path2D from an SVG path string (lines, cubic, arc, relative)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const at = (ctx, x, y) => ctx.getImageData(x, y, 1, 1).data[3];
      // A square via relative h/v/z.
      const sq = new Path2D('M2 2 h6 v6 h-6 z');
      const c1 = new OffscreenCanvas(12, 12).getContext('2d'); c1.fillStyle = '#00f'; c1.fill(sq);
      // A filled disc via two arcs (A command) — big circle centred at (10,10) r=8.
      const disc = new Path2D('M2 10 A8 8 0 1 0 18 10 A8 8 0 1 0 2 10 Z');
      const c2 = new OffscreenCanvas(20, 20).getContext('2d'); c2.fillStyle = '#f00'; c2.fill(disc);
      // A cubic bezier region (closed) fills something.
      const cv = new Path2D('M2 10 C2 2 18 2 18 10 Z');
      const c3 = new OffscreenCanvas(20, 20).getContext('2d'); c3.fillStyle = '#0f0'; c3.fill(cv);
      let curvePainted = 0;
      const d3 = c3.getImageData(0, 0, 20, 20).data;
      for (let k = 3; k < d3.length; k += 4) if (d3[k] > 0) curvePainted++;
      JSON.stringify({
        sqIn: at(c1, 5, 5), sqOut: at(c1, 10, 10),
        discCentre: at(c2, 10, 10), discCorner: at(c2, 1, 1),
        curvePainted
      });
    JS
    r = JSON.parse(out)
    expect(r['sqIn']).to eq(255)
    expect(r['sqOut']).to eq(0)
    expect(r['discCentre']).to eq(255)   # inside the arc-built disc
    expect(r['discCorner']).to eq(0)     # corner outside the disc
    expect(r['curvePainted']).to be > 20 # the cubic region fills a region
  end

  it 'does not hang on a malformed SVG path string' do
    session = simulated_session(app)
    session.visit('/')
    out = Timeout.timeout(15) do
      session.evaluate_script(<<~JS)
        // A stray number after Z used to make the implicit-command repeat loop forever.
        const p = new Path2D('M0 0 h4 v4 Z 5 9 8');
        const ctx = new OffscreenCanvas(6, 6).getContext('2d');
        ctx.fillStyle = '#ff0000'; ctx.fill(p);
        JSON.stringify({ inside: ctx.isPointInPath(p, 1, 1) });
      JS
    end
    expect(JSON.parse(out)['inside']).to be true   # the valid prefix still parsed + filled
  end

  it 'Path2D copy constructor and addPath compose paths' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const at = (ctx, x, y) => ctx.getImageData(x, y, 1, 1).data[3];
      const base = new Path2D('M0 0 h4 v4 h-4 z');
      // addPath with a translate transform places a copy at (6,6).
      const composed = new Path2D(base);       // copy constructor → square at origin
      composed.addPath(base, { a: 1, b: 0, c: 0, d: 1, e: 6, f: 6 });
      const ctx = new OffscreenCanvas(12, 12).getContext('2d');
      ctx.fillStyle = '#0f0'; ctx.fill(composed);
      JSON.stringify({ orig: at(ctx, 1, 1), moved: at(ctx, 7, 7), between: at(ctx, 5, 5) });
    JS
    r = JSON.parse(out)
    expect(r['orig']).to eq(255)         # copied square at origin
    expect(r['moved']).to eq(255)        # translated square at (6,6)
    expect(r['between']).to eq(0)        # gap between them
  end

  it 'addPath handles self-addition and the m11-m42 matrix alias without hanging' do
    session = simulated_session(app)
    session.visit('/')
    out = Timeout.timeout(15) do
      session.evaluate_script(<<~JS)
        const p = new Path2D(); p.rect(0, 0, 4, 4);
        const before = p._path.length;
        p.addPath(p);                                  // self-addition must not loop
        // DOMMatrix2DInit alias form {m11,m22} → scale 2×.
        const q = new Path2D('M0 0 h2 v2 h-2 z');
        const r = new Path2D(); r.addPath(q, { m11: 2, m22: 2 });
        const ctx = new OffscreenCanvas(6, 6).getContext('2d'); ctx.fillStyle = '#f00'; ctx.fill(r);
        JSON.stringify({ doubled: p._path.length === before * 2, scaledInside: ctx.isPointInPath(r, 3, 3) });
      JS
    end
    r = JSON.parse(out)
    expect(r['doubled']).to be true
    expect(r['scaledInside']).to be true  # {m11:2,m22:2} scaled the 2×2 square to cover (3,3)
  end

  it 'anti-aliases a fractional edge (partial coverage) while keeping integer edges exact' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      // Axis-aligned box with a fractional left edge at x=0.5.
      const box = new OffscreenCanvas(4, 2).getContext('2d');
      box.fillStyle = '#ff0000';
      box.fillRect(0.5, 0, 2, 2);           // left edge halves column 0
      const bd = box.getImageData(0, 0, 4, 2).data;
      // A rotated (non-axis-aligned) triangle produces AA on its diagonal.
      const tri = new OffscreenCanvas(8, 8).getContext('2d');
      tri.fillStyle = '#000000';
      tri.beginPath(); tri.moveTo(0, 0); tri.lineTo(8, 0); tri.lineTo(0, 8); tri.closePath(); tri.fill();
      const td = tri.getImageData(0, 0, 8, 8).data;
      // Count how many pixels have a partial (non-0, non-255) alpha → AA present.
      let partial = 0;
      for (let k = 3; k < td.length; k += 4) if (td[k] > 0 && td[k] < 255) partial++;
      JSON.stringify({
        edgeAlpha: bd[0 * 4 + 3],     // column 0: ~half-covered
        insideAlpha: bd[1 * 4 + 3],   // column 1: fully covered
        partial
      });
    JS
    r = JSON.parse(out)
    expect(r['edgeAlpha']).to be_between(100, 160)   # ~0.5 coverage on the fractional edge
    expect(r['insideAlpha']).to eq(255)              # integer-aligned interior stays exact
    expect(r['partial']).to be > 3                   # the diagonal is anti-aliased
  end

  it 'throws (not crashes) on an un-allocatably large getImageData / ImageData' do
    session = simulated_session(app)
    session.visit('/')
    out = Timeout.timeout(15) do
      session.evaluate_script(<<~JS)
        const ctx = new OffscreenCanvas(10, 10).getContext('2d');
        const errs = {};
        // A ~2^31-pixel region can't be backed. Rather than aborting the process on
        // the huge allocation, getImageData throws TypeError and the ImageData
        // constructor throws IndexSizeError (matching real browsers / WPT).
        try { ctx.getImageData(10, 0xffffffff, 2147483647, 10); } catch (e) { errs.get = e.name; }
        try { new ImageData(2147483647, 10); } catch (e) { errs.ctor = e.name; }
        // A normal region still works.
        const ok = ctx.getImageData(0, 0, 4, 4).data.length;
        JSON.stringify({ errs, ok });
      JS
    end
    r = JSON.parse(out)
    expect(r['errs']['get']).to eq('TypeError')
    expect(r['errs']['ctor']).to eq('IndexSizeError')
    expect(r['ok']).to eq(64)   # 4×4×4 — normal getImageData unaffected
  end

  it 'createPattern tiles an image source (repeat / no-repeat) and validates args' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      // A 2×2 tile: top-left red, rest transparent.
      const tile = new OffscreenCanvas(2, 2); const t = tile.getContext('2d');
      t.fillStyle = '#ff0000'; t.fillRect(0, 0, 1, 1);
      // repeat: red repeats every 2px.
      const c = new OffscreenCanvas(4, 4).getContext('2d');
      const p = c.createPattern(tile, 'repeat');
      c.fillStyle = p; c.fillRect(0, 0, 4, 4);
      // no-repeat: only the single tile shows.
      const c2 = new OffscreenCanvas(4, 4).getContext('2d');
      c2.fillStyle = c2.createPattern(tile, 'no-repeat'); c2.fillRect(0, 0, 4, 4);
      const errs = {};
      try { c.createPattern(null, 'repeat'); } catch (e) { errs.null = e.constructor.name; }
      try { c.createPattern(tile, 'bogus'); } catch (e) { errs.rep = e.name; }
      JSON.stringify({
        repRed: px(c, 0, 0), repGap: px(c, 1, 0), repTile2: px(c, 2, 0),
        nrRed: px(c2, 0, 0), nrGap: px(c2, 2, 0),
        errs, isPat: p instanceof CanvasPattern
      });
    JS
    r = JSON.parse(out)
    expect(r['repRed']).to eq([255, 0, 0, 255])    # tile origin
    expect(r['repGap']).to eq([0, 0, 0, 0])         # transparent tile cell
    expect(r['repTile2']).to eq([255, 0, 0, 255])   # next tile repeats
    expect(r['nrRed']).to eq([255, 0, 0, 255])
    expect(r['nrGap']).to eq([0, 0, 0, 0])          # no-repeat: nothing past one tile
    expect(r['errs']['null']).to eq('TypeError')
    expect(r['errs']['rep']).to eq('SyntaxError')
    expect(r['isPat']).to be true
  end

  it 'loads an <img> resource asynchronously (pending request, then load event + drawImage)' do
    session = simulated_session(app)
    session.visit('/')
    # The fetch runs on a host thread, as a browser's does: within the assigning script the
    # element models the spec's PENDING request — `complete` false, no intrinsic size, and a
    # drawImage of it is the silent no-op the spec prescribes for a not-fully-decodable image.
    out = session.evaluate_async_script(<<~JS)
      const cb = arguments[arguments.length - 1];
      const img = document.createElement('img');
      const pendingAfterSrc = new Promise((res) => {
        img.addEventListener('load', () => res(null));
        img.src = '/test.png';
      });
      const pending = { naturalWidth: img.naturalWidth, complete: img.complete };
      pendingAfterSrc.then(() => {
        const c = document.createElement('canvas'); c.width = 4; c.height = 3;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        cb(JSON.stringify({
          pending,
          naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
          width: img.width, height: img.height, complete: img.complete,
          pxRed: Array.from(ctx.getImageData(0, 0, 1, 1).data),
          pxGreen: Array.from(ctx.getImageData(1, 0, 1, 1).data)
        }));
      });
    JS
    r = JSON.parse(out)
    expect(r['pending']).to eq('naturalWidth' => 0, 'complete' => false)
    expect(r['naturalWidth']).to eq(4)
    expect(r['naturalHeight']).to eq(3)
    expect(r['width']).to eq(4)      # width/height default to the intrinsic size
    expect(r['height']).to eq(3)
    expect(r['complete']).to be true
    expect(r['pxRed']).to eq([255, 0, 0, 255])
    expect(r['pxGreen']).to eq([0, 255, 0, 255])
  end

  it 'fires load asynchronously and error for a broken <img>' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_async_script(<<~JS)
      const cb = arguments[arguments.length - 1];
      (async () => {
        const ok = await new Promise((res) => {
          const img = new Image();
          img.onload = () => res({ w: img.naturalWidth, complete: img.complete });
          img.src = '/test.png';
        });
        const bad = await new Promise((res) => {
          const img = new Image();
          img.onerror = () => res({ w: img.naturalWidth, complete: img.complete });
          img.src = '/missing.png';
        });
        cb(JSON.stringify({ ok, bad }));
      })();
    JS
    r = JSON.parse(out)
    expect(r['ok']['w']).to eq(4)
    expect(r['ok']['complete']).to be true
    expect(r['bad']['w']).to eq(0)     # broken image has no intrinsic size
    expect(r['bad']['complete']).to be true
  end

  it 'decodes a parsed <img src> so it is ready for drawImage after load' do
    parse_app = Rack::Builder.new {
      png = Base64.decode64(
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAACXBIWXMAAAPoAAAD6AG1e1JrA' \
        'AAAI0lEQVQImSWKwREAAAiCGJ3NrQw/ckogDSksUbdVf/BenpgBvkUa6QrxoaEAAAAASUVORK5CYII='
      )
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'         then [200, {'content-type' => 'text/html'}, ['<html><body><img id="i" src="/test.png"><canvas id="c" width="4" height="3"></canvas></body></html>']]
        when '/test.png' then [200, {'content-type' => 'image/png'}, [png]]
        else                  [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
    session = simulated_session(parse_app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const img = document.getElementById('i');
      const ctx = document.getElementById('c').getContext('2d');
      ctx.drawImage(img, 0, 0);
      JSON.stringify({
        naturalWidth: img.naturalWidth, complete: img.complete,
        pxBlue: Array.from(ctx.getImageData(2, 0, 1, 1).data)
      });
    JS
    r = JSON.parse(out)
    expect(r['naturalWidth']).to eq(4)
    expect(r['complete']).to be true
    expect(r['pxBlue']).to eq([0, 0, 255, 255])
  end

  it 'decodes a data: URL <img> (no fetch) and draws it' do
    session = simulated_session(app)
    session.visit('/')
    data_url = 'data:image/png;base64,' + Base64.strict_encode64(png_bytes)
    out = session.evaluate_script(<<~JS)
      const img = new Image();
      img.src = #{data_url.inspect};
      const c = document.createElement('canvas'); c.width = 4; c.height = 3;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      JSON.stringify({
        w: img.naturalWidth, h: img.naturalHeight, complete: img.complete,
        pxRed: Array.from(ctx.getImageData(0, 0, 1, 1).data)
      });
    JS
    r = JSON.parse(out)
    expect(r['w']).to eq(4)
    expect(r['h']).to eq(3)
    expect(r['complete']).to be true
    expect(r['pxRed']).to eq([255, 0, 0, 255])
  end

  it 'does not load images parsed into a DOMParser document (inert, no browsing context)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const doc = new DOMParser().parseFromString('<img src="/test.png">', 'text/html');
      const img = doc.querySelector('img');
      JSON.stringify({ naturalWidth: img.naturalWidth, complete: img.complete });
    JS
    r = JSON.parse(out)
    expect(r['naturalWidth']).to eq(0)   # DOMParser docs never fetch resources
    expect(r['complete']).to be false
  end

  it 'resets natural size and re-arms loading when src is cleared' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_async_script(<<~JS)
      const cb = arguments[arguments.length - 1];
      const img = new Image();
      const await_load = () => new Promise((res) => img.addEventListener('load', () => res(null), { once: true }));
      (async () => {
        const p1 = await_load(); img.src = '/test.png'; await p1;
        const loaded = { w: img.naturalWidth };
        img.removeAttribute('src');
        const cleared = { w: img.naturalWidth, complete: img.complete };
        const p2 = await_load(); img.src = '/test.png'; await p2;   // same src again — must re-load, not be swallowed
        const reloaded = { w: img.naturalWidth };
        cb(JSON.stringify({ loaded, cleared, reloaded }));
      })();
    JS
    r = JSON.parse(out)
    expect(r['loaded']['w']).to eq(4)
    expect(r['cleared']['w']).to eq(0)       # cleared src resets intrinsic size
    expect(r['cleared']['complete']).to be true
    expect(r['reloaded']['w']).to eq(4)      # re-assigning the same src reloads
  end

  it 'validates line-style IDL setters (ignoring out-of-range values)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = new OffscreenCanvas(10, 10).getContext('2d');
      const r = {};
      c.lineWidth = 4;   c.lineWidth = 0; c.lineWidth = -2; c.lineWidth = Infinity; r.width = c.lineWidth;
      c.lineWidth = '2.5'; r.widthStr = c.lineWidth;
      c.lineCap = 'round'; c.lineCap = 'ROUND'; c.lineCap = 'bogus'; r.cap = c.lineCap;
      c.lineJoin = 'bevel'; c.lineJoin = ''; r.join = c.lineJoin;
      c.miterLimit = 3; c.miterLimit = 0; c.miterLimit = -1; r.miter = c.miterLimit;
      JSON.stringify(r);
    JS
    r = JSON.parse(out)
    expect(r['width']).to eq(4)      # 0 / negative / Infinity all ignored
    expect(r['widthStr']).to eq(2.5) # numeric string coerced
    expect(r['cap']).to eq('round')  # 'ROUND' / 'bogus' ignored
    expect(r['join']).to eq('bevel') # '' ignored
    expect(r['miter']).to eq(3)      # 0 / negative ignored
  end

  it 'renders a rounded line join (round bulge past the miter corner)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const mk = (join) => {
        const c = new OffscreenCanvas(60, 60).getContext('2d');
        c.lineWidth = 20; c.strokeStyle = '#f00'; c.lineJoin = join;
        c.beginPath(); c.moveTo(10, 20); c.lineTo(40, 20); c.lineTo(40, 50); c.stroke();
        return c;
      };
      // Outer corner pixel at (48,12): a miter fills it; a round join does not
      // (it is >10px from the vertex (40,20): dist = sqrt(8^2+8^2) = 11.3).
      JSON.stringify({ miter: px(mk('miter'), 48, 12), round: px(mk('round'), 48, 12) });
    JS
    r = JSON.parse(out)
    expect(r['miter']).to eq([255, 0, 0, 255])  # miter reaches the square corner
    expect(r['round']).to eq([0, 0, 0, 0])       # round join is clipped to the radius
  end

  it 'fills a full circle from an anticlockwise arc(0, 2*PI, true)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = new OffscreenCanvas(40, 40).getContext('2d');
      ctx.fillStyle = '#f00';
      ctx.beginPath(); ctx.moveTo(20, 20); ctx.arc(20, 20, 10, 0, 2 * Math.PI, true); ctx.fill();
      JSON.stringify({
        center: Array.from(ctx.getImageData(20, 20, 1, 1).data),
        outside: Array.from(ctx.getImageData(20, 35, 1, 1).data)
      });
    JS
    r = JSON.parse(out)
    expect(r['center']).to eq([255, 0, 0, 255])  # full disc, not an empty zero-sweep arc
    expect(r['outside']).to eq([0, 0, 0, 0])
  end

  it 'maps the canvas width/height attributes to computed CSS width/height' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const parse = (attr) => {
        const c = document.createElement('canvas');
        if (attr != null) c.setAttribute('width', attr);
        document.body.appendChild(c);
        return { w: c.width, css: getComputedStyle(c).getPropertyValue('width') };
      };
      JSON.stringify({
        deflt: parse(null),        // no attribute -> default 300
        dec:   parse('100.999'),   // parsed as a non-negative integer
        zero:  parse('0'),
        hex:   parse('0x100'),     // stops at 'x'
        pct:   parse('100%')       // stops at '%'
      });
    JS
    r = JSON.parse(out)
    expect(r['deflt']).to eq('w' => 300, 'css' => '300px')  # default canvas size is a presentational hint
    expect(r['dec']).to  eq('w' => 100, 'css' => '100px')
    expect(r['zero']).to eq('w' => 0,   'css' => '0px')
    expect(r['hex']).to  eq('w' => 0,   'css' => '0px')
    expect(r['pct']).to  eq('w' => 100, 'css' => '100px')
  end

  it 'exposes context.canvas as a readonly attribute' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      const other = document.createElement('canvas');
      ctx.canvas = other;   // no-op: readonly
      JSON.stringify({ same: ctx.canvas === c, notReplaced: ctx.canvas !== other });
    JS
    r = JSON.parse(out)
    expect(r['same']).to be true
    expect(r['notReplaced']).to be true
  end

  it 'validates the ImageData constructor and exposes readonly members' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name || e.constructor.name; } };
      const d = new ImageData(2, 3);
      d.width = 99; d.height = 99;                 // readonly: no-op
      JSON.stringify({
        width: d.width, height: d.height, len: d.data.length,
        colorSpace: d.colorSpace, pixelFormat: d.pixelFormat,
        readonly: (d.width === 2 && d.height === 3),
        missingHeight: err(() => new ImageData(10)),                          // TypeError
        zero:         err(() => new ImageData(0, 10)),                        // IndexSizeError
        badArray:     err(() => new ImageData(new Uint8Array(8), 1, 2)),      // TypeError
        badLen:       err(() => new ImageData(new Uint8ClampedArray(27), 2)), // InvalidStateError
        mismatch:     err(() => new ImageData(new Uint8ClampedArray(4), 1, 2)), // IndexSizeError
        fromData:     (() => { const i = new ImageData(new Uint8ClampedArray(28), 7); return [i.width, i.height]; })()
      });
    JS
    r = JSON.parse(out)
    expect(r['width']).to eq(2)
    expect(r['height']).to eq(3)
    expect(r['len']).to eq(24)
    expect(r['colorSpace']).to eq('srgb')
    expect(r['pixelFormat']).to eq('rgba-unorm8')
    expect(r['readonly']).to be true
    expect(r['missingHeight']).to eq('TypeError')
    expect(r['zero']).to eq('IndexSizeError')
    expect(r['badArray']).to eq('TypeError')
    expect(r['badLen']).to eq('InvalidStateError')
    expect(r['mismatch']).to eq('IndexSizeError')
    expect(r['fromData']).to eq([7, 1])
  end

  it 'validates createImageData / getImageData / putImageData arguments' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas'); c.width = 20; c.height = 20;
      const ctx = c.getContext('2d');
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name || e.constructor.name; } };
      const id = ctx.createImageData(10, 20);
      JSON.stringify({
        negMagnitude: [ctx.createImageData(-10, 20).width, ctx.createImageData(-10, 20).height], // abs
        doubleTrunc:  ctx.createImageData(10.9, 10.1).width,                    // -> 10
        createZero:   err(() => ctx.createImageData(10, 0)),                    // IndexSizeError
        createInf:    err(() => ctx.createImageData(Infinity, 10)),             // TypeError
        createNull:   err(() => ctx.createImageData(null)),                     // TypeError
        getZero:      err(() => ctx.getImageData(1, 1, 0, 10)),                 // IndexSizeError
        getNaN:       err(() => ctx.getImageData(NaN, 1, 10, 10)),              // TypeError
        putInf:       err(() => ctx.putImageData(id, Infinity, 10)),            // TypeError
        putWrongType: err(() => ctx.putImageData('cheese', 0, 0)),             // TypeError
        wrongThis:    err(() => CanvasRenderingContext2D.prototype.createImageData.call(null, 1, 1))
      });
    JS
    r = JSON.parse(out)
    expect(r['negMagnitude']).to eq([10, 20])
    expect(r['doubleTrunc']).to eq(10)
    expect(r['createZero']).to eq('IndexSizeError')
    expect(r['createInf']).to eq('TypeError')
    expect(r['createNull']).to eq('TypeError')
    expect(r['getZero']).to eq('IndexSizeError')
    expect(r['getNaN']).to eq('TypeError')
    expect(r['putInf']).to eq('TypeError')
    expect(r['putWrongType']).to eq('TypeError')
    expect(r['wrongThis']).to eq('TypeError')
  end

  it 'createPattern: null for an unusable image, throws for broken / bad repetition' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = document.createElement('canvas').getContext('2d');
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name || e.constructor.name; } };
      const nosrc  = new Image();                         // never loaded -> null
      const svgImg = document.createElementNS('http://www.w3.org/2000/svg', 'image'); // unavailable -> null
      JSON.stringify({
        nosrc:      ctx.createPattern(nosrc, 'repeat'),                    // null
        svgImage:   ctx.createPattern(svgImg, 'repeat'),                   // null (unavailable, not broken)
        undef:      err(() => ctx.createPattern(document.createElement('canvas'), undefined)), // SyntaxError
        bad:        err(() => ctx.createPattern(document.createElement('canvas'), 'nope')),    // SyntaxError
        str:        err(() => ctx.createPattern('not-an-image', 'repeat')),                    // TypeError
        emptyRep:   (() => { const c = document.createElement('canvas'); c.width = 2; c.height = 2;
                             return ctx.createPattern(c, '') instanceof CanvasPattern; })()     // '' -> 'repeat'
      });
    JS
    r = JSON.parse(out)
    expect(r['nosrc']).to be_nil
    expect(r['svgImage']).to be_nil
    expect(r['undef']).to eq('SyntaxError')
    expect(r['bad']).to eq('SyntaxError')
    expect(r['str']).to eq('TypeError')
    expect(r['emptyRep']).to be true
  end

  it 'loads a zero-intrinsic-dimension image as complete + not broken, with no pixels' do
    session = simulated_session(app)
    session.visit('/')
    # An SVG with width 0 is a VALID image (rsvg refuses to rasterize a 0-dimension
    # canvas, but the resource loaded): the <img> is complete, not broken, and reports
    # a zero-area intrinsic size. createPattern -> null and drawImage -> no-op, never a
    # broken-image throw.
    out = session.evaluate_script(<<~JS)
      const svg = "data:image/svg+xml," + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='0' height='100'>" +
        "<rect fill='red' width='100' height='100'/></svg>");
      const img = new Image();
      img.src = svg;
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      const ctx = document.createElement('canvas').getContext('2d');
      JSON.stringify({
        complete:  img.complete,
        nw:        img.naturalWidth,
        pattern:   ctx.createPattern(img, 'repeat'),          // null (available-but-empty, not broken)
        draw:      err(() => ctx.drawImage(img, 0, 0))        // no-op, no throw
      });
    JS
    r = JSON.parse(out)
    # Observable "loaded, zero-area, NOT broken": complete, zero intrinsic size, and a
    # null (not throwing) createPattern — a broken image would instead throw here.
    expect(r['complete']).to be true
    expect(r['nw']).to eq(0)
    expect(r['pattern']).to be_nil
    expect(r['draw']).to eq('no-throw')
  end

  it 'loads an SVG <image> resource (href / xlink:href) like an <img>' do
    session = simulated_session(app)
    session.visit('/')
    # An SVG <image> fetches its href just like an <img> src, so createPattern can tell a
    # BROKEN href (throw InvalidStateError) from a usable bitmap (a real pattern).
    out = session.evaluate_script(<<~JS)
      const mk = (href, ns) => { const im = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        im.setAttribute(ns ? 'href' : 'xlink:href', href); return im; };
      const good   = mk("data:image/svg+xml," + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect fill='red' width='8' height='8'/></svg>"), true);
      const broken = mk("data:image/png;base64,bm90LWEtcG5n", false);   // undecodable -> broken
      const ctx = document.createElement('canvas').getContext('2d');
      const err = (fn) => { try { return fn(); } catch (e) { return e.name; } };
      JSON.stringify({
        good:   ctx.createPattern(good, 'repeat') instanceof CanvasPattern,
        broken: err(() => { ctx.createPattern(broken, 'repeat'); return 'no-throw'; })
      });
    JS
    r = JSON.parse(out)
    # A usable href yields a real pattern; a broken href throws InvalidStateError
    # (observably distinguishing loaded from broken).
    expect(r['good']).to be true
    expect(r['broken']).to eq('InvalidStateError')
  end

  it 'reloads an SVG <image> on setAttributeNS(xlink) / removeAttribute and defers empty href to xlink:href' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const XLINK = 'http://www.w3.org/1999/xlink';
      const url = "data:image/svg+xml," + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect fill='red' width='8' height='8'/></svg>");
      const ctx = document.createElement('canvas').getContext('2d');
      const isPat = (im) => ctx.createPattern(im, 'repeat') instanceof CanvasPattern;
      const mk = () => document.createElementNS('http://www.w3.org/2000/svg', 'image');
      // Canonical xlink:href set fetches the resource.
      const ns = mk(); ns.setAttributeNS(XLINK, 'xlink:href', url);
      const nsLoaded = isPat(ns);
      // Removing the sourcing attribute discards the request.
      ns.removeAttribute('xlink:href');
      const afterRemove = ctx.createPattern(ns, 'repeat');   // null
      // An empty href defers to a valid xlink:href rather than blanking.
      const fb = mk(); fb.setAttribute('href', ''); fb.setAttribute('xlink:href', url);
      const fallback = isPat(fb);
      JSON.stringify({ nsLoaded, afterRemove, fallback });
    JS
    r = JSON.parse(out)
    expect(r['nsLoaded']).to be true
    expect(r['afterRemove']).to be_nil
    expect(r['fallback']).to be true
  end

  it 'parses colour keywords case-insensitively and auto-closes an unclosed function' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (v) => { const c = document.createElement('canvas'); c.width = 2; c.height = 2;
        const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillStyle = v; x.fillRect(0, 0, 2, 2);
        return Array.from(x.getImageData(0, 0, 1, 1).data); };
      JSON.stringify({
        transparent: px('TrAnSpArEnT'),   // case-insensitive keyword
        rgbEof:      px('rgb(0, 255, 0'),  // auto-closed
        rgbaEof:     px('rgba(0, 255, 0, 1')
      });
    JS
    r = JSON.parse(out)
    expect(r['transparent']).to eq([0, 0, 0, 0])
    expect(r['rgbEof']).to eq([0, 255, 0, 255])
    expect(r['rgbaEof']).to eq([0, 255, 0, 255])
  end

  it 'bakes the transform into path points at add-time, not at fill-time' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas'); c.width = 100; c.height = 50;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 100, 50);
      ctx.fillStyle = '#0f0';
      // Build a rect while the transform shifts, then change the transform before
      // filling — the already-added points must keep their add-time positions.
      ctx.translate(-100, 0);
      ctx.rect(100, 0, 100, 50);   // baked to (0,0)-(100,50)
      ctx.translate(0, -100);      // must NOT move the rect
      ctx.fill();
      const mid = Array.from(ctx.getImageData(50, 25, 1, 1).data);
      // isPointInPath uses canvas coords (transform-independent) against the baked path.
      JSON.stringify({ mid, in: ctx.isPointInPath(50, 25), out: ctx.isPointInPath(150, 25) });
    JS
    r = JSON.parse(out)
    expect(r['mid']).to eq([0, 255, 0, 255])   # rect stayed at (0,0)-(100,50)
    expect(r['in']).to be true
    expect(r['out']).to be false
  end

  it 'scales the stroke pen by the transform in effect at stroke time' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const c = document.createElement('canvas'); c.width = 100; c.height = 50;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 100, 50);
      ctx.beginPath(); ctx.rect(25, 12.5, 50, 25);   // built at identity
      ctx.scale(50, 25);                             // pen scales, path points do not
      ctx.strokeStyle = '#0f0'; ctx.stroke();
      // The thick (50x25) pen fills the canvas green.
      JSON.stringify(Array.from(ctx.getImageData(50, 25, 1, 1).data));
    JS
    expect(JSON.parse(out)).to eq([0, 255, 0, 255])
  end

  it 'throws IndexSizeError for a negative arc / arcTo / ellipse radius' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = document.createElement('canvas').getContext('2d');
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      JSON.stringify({
        arc:      err(() => ctx.arc(0, 0, -1, 0, 1, false)),
        arcTo:    err(() => ctx.arcTo(0, 0, 10, 10, -5)),
        ellipse:  err(() => ctx.ellipse(0, 0, -2, 5, 0, 0, 1, false)),
        arcOk:    err(() => ctx.arc(0, 0, 5, 0, 1, false)),          // positive: fine
        ellipseZero: err(() => ctx.ellipse(0, 0, 0, 5, 0, 0, 1)),    // zero radius: fine
        nonfinite: err(() => ctx.arc(0, 0, Infinity, 0, 1))          // non-finite: silent no-op
      });
    JS
    r = JSON.parse(out)
    expect(r['arc']).to eq('IndexSizeError')
    expect(r['arcTo']).to eq('IndexSizeError')
    expect(r['ellipse']).to eq('IndexSizeError')
    expect(r['arcOk']).to eq('no-throw')
    expect(r['ellipseZero']).to eq('no-throw')
    expect(r['nonfinite']).to eq('no-throw')
  end

  it 'drawImage honors the transform, globalAlpha, and compositing operator' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const mkSrc = () => { const c = new OffscreenCanvas(10, 10); const x = c.getContext('2d');
        x.fillStyle = '#f00'; x.fillRect(0, 0, 10, 10); return c; };
      // translate: the image lands at the translated position, not the origin.
      const a = new OffscreenCanvas(40, 40).getContext('2d');
      a.translate(20, 20); a.drawImage(mkSrc(), 0, 0);
      // globalAlpha: half-opacity red over green -> blended.
      const b = new OffscreenCanvas(10, 10).getContext('2d');
      b.fillStyle = '#0f0'; b.fillRect(0, 0, 10, 10);
      b.globalAlpha = 0.5; b.drawImage(mkSrc(), 0, 0);
      // destination-over: the image goes UNDER existing content.
      const c = new OffscreenCanvas(10, 10).getContext('2d');
      c.fillStyle = '#0f0'; c.fillRect(0, 0, 10, 10);
      c.globalCompositeOperation = 'destination-over'; c.drawImage(mkSrc(), 0, 0);
      JSON.stringify({
        atOrigin: px(a, 5, 5),        // empty (image translated away)
        translated: px(a, 25, 25),    // red at the translated spot
        blended: px(b, 5, 5),         // ~half red over green
        destOver: px(c, 5, 5)         // stays green (image drawn under)
      });
    JS
    r = JSON.parse(out)
    expect(r['atOrigin']).to eq([0, 0, 0, 0])
    expect(r['translated']).to eq([255, 0, 0, 255])
    expect(r['blended'][0]).to be_between(120, 135)   # red channel ~half
    expect(r['blended'][1]).to be_between(120, 135)   # green channel ~half
    expect(r['destOver']).to eq([0, 255, 0, 255])
  end

  it 'drawImage validates its arguments (TypeError / no-op / zero-canvas)' do
    session = simulated_session(app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const ctx = document.createElement('canvas').getContext('2d');
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      const good = new OffscreenCanvas(10, 10);
      JSON.stringify({
        nullSrc:  err(() => ctx.drawImage(null, 0, 0)),                 // TypeError
        strSrc:   err(() => ctx.drawImage('x', 0, 0)),                  // TypeError
        nonfinite: err(() => ctx.drawImage(good, Infinity, 0)),        // no-op (no throw)
        zeroSrc:  err(() => ctx.drawImage(good, 0, 0, 0, 5, 0, 0, 10, 10)), // no-op
        zeroCanvas: err(() => ctx.drawImage(new OffscreenCanvas(0, 0), 0, 0)), // InvalidStateError
        blankCanvas: err(() => ctx.drawImage(document.createElement('canvas'), 0, 0)) // no-op
      });
    JS
    r = JSON.parse(out)
    expect(r['nullSrc']).to eq('TypeError')
    expect(r['strSrc']).to eq('TypeError')
    expect(r['nonfinite']).to eq('no-throw')
    expect(r['zeroSrc']).to eq('no-throw')
    expect(r['zeroCanvas']).to eq('InvalidStateError')
    expect(r['blankCanvas']).to eq('no-throw')
  end

  it 'HTMLCanvasElement.getContext("2d") returns a working 2D context' do
    session = simulated_session(app)
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
