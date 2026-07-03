# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require 'base64'
require 'timeout'

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
    # The 1px stroke straddles the box edge, so corner/edge pixels are AA-partial;
    # assert they're painted green rather than a specific alpha.
    expect(px[0][1]).to eq(255); expect(px[0][3]).to be > 0   # (0,0) corner stroked
    expect(px[3][1]).to eq(255); expect(px[3][3]).to be > 0   # (3,0) top edge stroked
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
    # Inside the new shape (seeded at its first control point 1,1); (2,2) sits near
    # the curved edge, so it's AA-partial — assert red and substantially covered.
    expect(at.call(2, 2)[0]).to eq(255)
    expect(at.call(2, 2)[3]).to be > 128
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

  it 'fills a rect with a horizontal linear gradient (endpoint colours + midpoint)' do
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app_fs)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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

  it 'createConicGradient sweeps colour around the centre' do
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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

  it 'fillText casts a shadow' do
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = Timeout.timeout(15) do
      session.evaluate_script(<<~JS)
        const ctx = new OffscreenCanvas(10, 10).getContext('2d');
        const errs = {};
        // A ~2^31-pixel region can't be backed — real browsers throw TypeError
        // rather than aborting the process on the huge allocation.
        try { ctx.getImageData(10, 0xffffffff, 2147483647, 10); } catch (e) { errs.get = e.constructor.name; }
        try { new ImageData(2147483647, 10); } catch (e) { errs.ctor = e.constructor.name; }
        // A normal region still works.
        const ok = ctx.getImageData(0, 0, 4, 4).data.length;
        JSON.stringify({ errs, ok });
      JS
    end
    r = JSON.parse(out)
    expect(r['errs']['get']).to eq('TypeError')
    expect(r['errs']['ctor']).to eq('TypeError')
    expect(r['ok']).to eq(64)   # 4×4×4 — normal getImageData unaffected
  end

  it 'createPattern tiles an image source (repeat / no-repeat) and validates args' do
    session = Capybara::Session.new(:simulated, app)
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

  it 'decodes an <img> resource on src assignment (naturalWidth/complete + load event + drawImage)' do
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const img = document.createElement('img');
      const events = [];
      img.addEventListener('load',  () => events.push('load'));
      img.addEventListener('error', () => events.push('error'));
      img.src = '/test.png';
      // Decode is synchronous, so the metrics are populated immediately; the
      // event is async, so it hasn't fired within this same script.
      const c = document.createElement('canvas'); c.width = 4; c.height = 3;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      JSON.stringify({
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        width: img.width, height: img.height, complete: img.complete,
        pxRed: Array.from(ctx.getImageData(0, 0, 1, 1).data),
        pxGreen: Array.from(ctx.getImageData(1, 0, 1, 1).data),
        events
      });
    JS
    r = JSON.parse(out)
    expect(r['naturalWidth']).to eq(4)
    expect(r['naturalHeight']).to eq(3)
    expect(r['width']).to eq(4)      # width/height default to the intrinsic size
    expect(r['height']).to eq(3)
    expect(r['complete']).to be true
    expect(r['pxRed']).to eq([255, 0, 0, 255])
    expect(r['pxGreen']).to eq([0, 255, 0, 255])
    expect(r['events']).to eq([])    # load is deferred to a microtask
  end

  it 'fires load asynchronously and error for a broken <img>' do
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, parse_app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
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
    session = Capybara::Session.new(:simulated, app)
    session.visit('/')
    out = session.evaluate_script(<<~JS)
      const img = new Image();
      img.src = '/test.png';
      const loaded = { w: img.naturalWidth };
      img.removeAttribute('src');
      const cleared = { w: img.naturalWidth, complete: img.complete };
      img.src = '/test.png';   // same src again — must re-decode, not be swallowed
      const reloaded = { w: img.naturalWidth };
      JSON.stringify({ loaded, cleared, reloaded });
    JS
    r = JSON.parse(out)
    expect(r['loaded']['w']).to eq(4)
    expect(r['cleared']['w']).to eq(0)       # cleared src resets intrinsic size
    expect(r['cleared']['complete']).to be true
    expect(r['reloaded']['w']).to eq(4)      # re-assigning the same src reloads
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
