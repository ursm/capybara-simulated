require_relative 'spec_helper'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `canvas.toBlob` must emit the encoded image as raw binary. The libvips
# encoder hands back a byte buffer; if that buffer is funnelled through a
# latin1 string into the Blob constructor it becomes a USVString part and
# gets UTF-8-encoded on readback, so every byte >= 0x80 is doubled and the
# PNG signature picks up a spurious 0xC2 prefix — a corrupt image. Discourse's
# composer video-thumbnail upload hit exactly this: the server rejected the
# poster PNG with "couldn't determine the size of the image" (HTTP 422) and
# the upload chain stalled. Guard the byte-exact round-trip here.
RSpec.describe 'canvas.toBlob binary integrity' do
  let(:app) {
    ->(_e) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
  }

  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  it 'emits a valid PNG whose bytes survive intact (no UTF-8 mangling)' do
    result = session.evaluate_script(<<~JS)
      (function(){
        var w = 4, h = 4;
        var data = new Uint8ClampedArray(w * h * 4);
        // Fill with values >= 0x80 — the bytes that UTF-8 mangling would double.
        for (var i = 0; i < data.length; i++) { data[i] = 0x80 + (i % 0x40); }
        var img = new ImageData(data, w, h);
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').putImageData(img, 0, 0);
        window.__sig = null;
        c.toBlob(function(blob){
          blob.arrayBuffer().then(function(ab){
            var b = new Uint8Array(ab);
            window.__sig = {
              size: blob.size,
              byteLength: b.byteLength,
              head: Array.from(b.slice(0, 8))
            };
          });
        });
      })()
    JS
    sig = poll_until { session.evaluate_script('window.__sig') }
    expect(sig).not_to be_nil
    # PNG signature: 137 80 78 71 13 10 26 10 — no leading 0xC2 (194).
    expect(sig['head']).to eq([137, 80, 78, 71, 13, 10, 26, 10])
    # blob.size must equal the actual byte length (a mangled blob reports the
    # inflated UTF-8 length).
    expect(sig['size']).to eq(sig['byteLength'])
  end

  it 'round-trips the encoded blob back through the image decoder' do
    dims = session.evaluate_script(<<~JS)
      (function(){
        var w = 8, h = 6;
        var data = new Uint8ClampedArray(w * h * 4);
        for (var i = 0; i < data.length; i++) { data[i] = (i * 7) & 0xff; }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
        window.__dims = null;
        c.toBlob(function(blob){
          createImageBitmap(blob).then(function(bm){
            window.__dims = {width: bm.width, height: bm.height};
          }).catch(function(e){ window.__dims = {error: String(e)}; });
        });
      })()
    JS
    out = poll_until { session.evaluate_script('window.__dims') }
    expect(out).to eq({'width' => 8, 'height' => 6})
  end

  it 'toDataURL emits a base64 PNG whose decoded bytes are a valid PNG' do
    require 'base64'
    url = session.evaluate_script(<<~JS)
      (function(){
        var w = 4, h = 4;
        var data = new Uint8ClampedArray(w * h * 4);
        for (var i = 0; i < data.length; i++) { data[i] = 0x80 + (i % 0x40); }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
        return c.toDataURL();
      })()
    JS
    expect(url).to start_with('data:image/png;base64,')
    png = Base64.decode64(url.delete_prefix('data:image/png;base64,'))
    expect(png[0, 8].bytes).to eq([137, 80, 78, 71, 13, 10, 26, 10])
  end

  it 'toDataURL of a zero-area canvas is the empty "data:," URL' do
    url = session.evaluate_script(<<~JS)
      (function(){
        var c = document.createElement('canvas');
        c.width = 0; c.height = 0;
        return c.toDataURL();
      })()
    JS
    expect(url).to eq('data:,')
  end

  it 'toDataURL of a sized but undrawn canvas is a valid (transparent) PNG' do
    require 'base64'
    url = session.evaluate_script(<<~JS)
      (function(){
        var c = document.createElement('canvas');
        c.width = 3; c.height = 2;   // sized, never drawn into
        return c.toDataURL();
      })()
    JS
    expect(url).to start_with('data:image/png;base64,')
    png = Base64.decode64(url.delete_prefix('data:image/png;base64,'))
    expect(png[0, 8].bytes).to eq([137, 80, 78, 71, 13, 10, 26, 10])
  end

  it 'toDataURL falls back to image/png for an unsupported type' do
    url = session.evaluate_script(<<~JS)
      (function(){
        var c = document.createElement('canvas');
        c.width = 2; c.height = 2;
        var d = new Uint8ClampedArray(16);
        for (var i = 0; i < 16; i++) { d[i] = 200; }
        c.getContext('2d').putImageData(new ImageData(d, 2, 2), 0, 0);
        return c.toDataURL('image/bogus');
      })()
    JS
    expect(url).to start_with('data:image/png;base64,')
  end
end
