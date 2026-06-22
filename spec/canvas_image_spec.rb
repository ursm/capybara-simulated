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
