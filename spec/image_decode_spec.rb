# frozen_string_literal: true

require 'capybara/simulated'
require 'json'
require_relative 'support/session_teardown'

# An image's bytes decoded natively (csim_native's image_decode.rs) — formats sniffed, colours managed — and the
# natural size an `<img>` is laid out from. Each figure below is Chrome's (measured), unless it says otherwise.
RSpec.describe 'image decode' do
  wpt = File.join(__dir__, 'wpt')
  images = {
    '/avif'  => 'images/green.avif',
    '/bmp'   => 'html/canvas/element/manual/wide-gamut-canvas/resources/pattern-srgb.bmp',
    '/ico'   => 'html/canvas/element/manual/wide-gamut-canvas/resources/pattern-srgb.ico',
    '/cmyk'  => 'html/canvas/element/manual/wide-gamut-canvas/resources/Generic-CMYK-FF000000.jpg',
    '/bg'    => 'images/left-half-rectangle-50.svg',
    '/bad'   => 'images/undecodable.png'
  }
  let(:app) {
    lambda {|env|
      path = env['PATH_INFO']
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] if path == '/'
      file = images.fetch(path)
      type = file.end_with?('.svg') ? 'image/svg+xml' : 'application/octet-stream'
      [200, {'content-type' => type}, [File.binread(File.join(wpt, file))]]
    }
  }

  # A pixel of each image drawn at its natural size, or what failed to load.
  def pixels(session, at)
    session.evaluate_async_script(<<~JS, at)
      const [done, at] = [arguments[1], arguments[0]];
      Promise.all(Object.entries(at).map(([src, [x, y]]) => new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          resolve([src, Array.from(g.getImageData(x, y, 1, 1).data)]);
        };
        img.onerror = () => resolve([src, 'error']);
        img.src = src;
      }))).then(r => done(Object.fromEntries(r)));
    JS
  end

  # A PNG corrupt past its header loads (Chrome: `load`, its size, nothing drawn) and is no source for a bitmap.
  it 'decodes AVIF, BMP, ICO and a CMYK JPEG, paints an SVG root background, and loads a corrupt PNG with nothing to draw' do
    s = simulated_session(app)
    s.visit '/'
    got = pixels(s, '/avif' => [0, 0], '/bmp' => [0, 0], '/ico' => [0, 0], '/cmyk' => [0, 0], '/bg' => [75, 50], '/bad' => [0, 0])
    expect(got['/avif'][0..2]).to satisfy {|(r, g, b)| r < 30 && g > 100 && b < 30 }
    expect(got['/bmp']).to eq(got['/ico'])
    # (…C 100% through the file's own Generic CMYK profile: a cyan)
    expect(got['/cmyk'][0..2]).to satisfy {|(r, g, b)| r < 64 && g > 128 && b > 192 }
    expect(got['/bg']).to eq([0, 0, 0, 128])
    expect(got['/bad']).to eq([0, 0, 0, 0])
  end

  # An SVG with no `width` / `height` reports the default object size, one with `width="0"` loads with no area.
  it 'sizes an SVG image as Chrome does' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const svg = attrs => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10"/></svg>`);
      const cases = {none: '', viewBox: 'viewBox="0 0 40 20"', w0: 'width="0" height="10"', wOnly: 'width="30"'};
      Promise.all(Object.entries(cases).map(([k, v]) => new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve([k, [img.naturalWidth, img.naturalHeight]]);
        img.onerror = () => resolve([k, 'error']);
        img.src = svg(v);
      }))).then(r => done(Object.fromEntries(r)));
    JS
    expect(got).to eq('none' => [300, 150], 'viewBox' => [300, 150], 'w0' => [0, 10], 'wOnly' => [30, 150])
  end

  # createImageBitmap's Blob decodes on the page's own thread, shrunk as it decodes where it is resized.
  it 'decodes a Blob for createImageBitmap' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      fetch('/bmp').then(r => r.blob()).then(b => Promise.all([createImageBitmap(b), createImageBitmap(b, {resizeWidth: 5, resizeHeight: 5})]))
        .then(([a, small]) => done([a.width, a.height, small.width, small.height]));
    JS
    expect(got).to eq([20, 20, 5, 5])
  end

  # A Display P3 image is told by its profile's primaries, not its name — the profile toDataURL writes names itself in
  # UTF-16 (ICC v4) — so a P3 canvas's PNG draws back into a P3 canvas unchanged.
  it 'reads a Display P3 profile by its primaries' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const p3 = () => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.getContext('2d', {colorSpace: 'display-p3'}); };
      const src = p3();
      src.fillStyle = 'red';
      src.fillRect(0, 0, 1, 1);
      const img = new Image();
      img.onload = () => { const dst = p3(); dst.drawImage(img, 0, 0); done([Array.from(src.getImageData(0, 0, 1, 1).data), Array.from(dst.getImageData(0, 0, 1, 1).data)]); };
      img.src = src.canvas.toDataURL();
    JS
    expect(got[1]).to eq(got[0])
  end

  # A corrupt AVIF — one a mutation made the AV1 decoder panic on — is a broken image, the process alive; and
  # createImageBitmap's imageOrientation is the spec's enum, "none" no member of it (HTML: "There used to be a none
  # enum value. It was renamed to from-image.").
  it 'breaks on an AVIF the decoder panics on, and refuses an imageOrientation that is no member' do
    crash = File.binread(File.join(__dir__, 'fixtures/media/crash.avif'))
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] if env['PATH_INFO'] == '/'
      [200, {'content-type' => 'image/avif'}, [crash]]
    })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const img = new Image();
      img.onerror = () => createImageBitmap(new ImageData(1, 1), {imageOrientation: 'none'}).then(() => done(['error', 'resolved']), e => done(['error', e.name]));
      img.onload = () => done(['load']);
      img.src = '/crash.avif';
    JS
    expect(got).to eq(%w[error TypeError])
  end
end
