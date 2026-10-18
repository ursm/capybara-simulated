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
    '/bad'   => 'images/undecodable.png',
    '/green' => 'images/green.png'
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

  it "reads an image element's members off its current request" do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const data = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
      const loaded = (img) => new Promise(resolve => { img.onload = img.onerror = resolve; });
      (async () => {
        const img = new Image();
        img.src = '/green?a';
        await loaded(img);
        const first = img.currentSrc.split('/').pop();
        img.src = data;
        await loaded(img);
        const second = [img.currentSrc === data, img.naturalWidth, img.complete];
        const set = new Image();
        set.srcset = '/green?b';
        await set.decode();
        const button = document.createElement('input');
        button.type = 'image';
        button.src = '/green';
        await loaded(button);
        const text = document.createElement('input');
        text.width = 7;
        done([first, second, [set.complete, set.currentSrc.split('/').pop()], [button.width, button.height], [text.width, text.getAttribute('width')], new Image().complete]);
      })();
    JS
    # Chrome's
    expect(got).to eq(['green?a', [true, 1, true], [true, 'green?b'], [100, 50], [0, '7'], true])
  end

  it "loads a clone of an image adopted into a frame, its node document's realm's to load" do
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><iframe src="/frame"></iframe>']] if env['PATH_INFO'] == '/'
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] if env['PATH_INFO'] == '/frame'
      [200, {'content-type' => 'image/png'}, [File.binread(File.join(__dir__, 'wpt/images/green.png'))]]
    })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const loaded = (img) => new Promise(resolve => { img.onload = img.onerror = resolve; });
      (async () => {
        const image = new Image();
        image.src = '/green.png';
        await loaded(image);
        document.querySelector('iframe').contentDocument.adoptNode(image);
        const copy = image.cloneNode();
        await loaded(copy);
        done([copy.complete, copy.naturalWidth, copy.currentSrc.split('/').pop()]);
      })();
    JS
    expect(got).to eq([true, 100, 'green.png'])
  end

  it 'loads an image a fragment parse made, and none whose frame is gone' do
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><iframe src="/frame"></iframe>']] if env['PATH_INFO'] == '/'
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] if env['PATH_INFO'] == '/frame'
      [200, {'content-type' => 'image/png'}, [File.binread(File.join(__dir__, 'wpt/images/green.png'))]]
    })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const loaded = (img) => new Promise(resolve => { img.onload = img.onerror = (e) => resolve(e.type); });
      (async () => {
        const holder = document.createElement('div');
        holder.innerHTML = '<img src="/green.png?a">';
        holder.insertAdjacentHTML('beforeend', '<img src="data:,">');
        const fragment = document.createRange().createContextualFragment('<img src="/green.png?b">');
        // (…and one in a declarative shadow root's tree)
        const host = document.createElement('div');
        host.setHTMLUnsafe('<p><template shadowrootmode=open><img src="/green.png?e"></template></p>');
        const shadowed = host.firstChild.shadowRoot.firstChild;
        const parsed = await Promise.all([...holder.children, ...fragment.children, shadowed].map(loaded));
        // (…an image adopted into a frame, the frame removed, then cloned: its node document is not fully active, so it
        // waits — and a later load in this document is the barrier it would have fired by)
        const frame = document.querySelector('iframe');
        const image = new Image();
        image.src = '/green.png?c';
        await loaded(image);
        frame.contentDocument.adoptNode(image);
        frame.remove();
        const copy = image.cloneNode();
        let copied = 'none';
        copy.onload = copy.onerror = (e) => { copied = e.type; };
        const barrier = new Image();
        barrier.src = '/green.png?d';
        await loaded(barrier);
        done([parsed, copied, copy.complete]);
      })();
    JS
    expect(got).to eq([%w[load error load load], 'none', false])
  end

  it 'loads an image an XML fragment parse made under a prefix' do
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'application/xhtml+xml'}, ['<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>']] if env['PATH_INFO'] == '/'
      [200, {'content-type' => 'image/png'}, [File.binread(File.join(__dir__, 'wpt/images/green.png'))]]
    })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const holder = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      holder.innerHTML = '<h:img xmlns:h="http://www.w3.org/1999/xhtml" src="/green.png"/>';
      const image = holder.firstChild;
      image.onload = image.onerror = (e) => done([image.localName, e.type, image.naturalWidth]);
    JS
    expect(got).to eq(['img', 'load', 100])
  end
  # `decode()` settles with the image's load itself, not through a listener: a page that replaced
  # `addEventListener` still has its decodes resolve — one whose pixels are corrupt past a good header among them, which
  # loads — and a broken image's reject. Chrome: ok, ok, EncodingError.
  it 'settles decode() by the load, whatever the page did to its events' do
    session = simulated_session(app).tap {|s| s.visit '/' }
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      EventTarget.prototype.addEventListener = () => {};
      const [good, corrupt, broken] = [new Image(), new Image(), new Image()];
      good.src = '/green';
      corrupt.src = '/bad';
      broken.src = 'data:text/plain,x';
      Promise.all([good, corrupt, broken].map((img) => img.decode().then(() => 'ok', (e) => e.name))).then(done);
    JS
    expect(got).to eq(%w[ok ok EncodingError])
  end

  # An `<img>`'s `x` / `y`: its first box's border edge, no transform applied, relative to the initial containing
  # block's origin — the page's — read through no member a page may replace. CSSOM View says so explicitly; Chrome and
  # Firefox measure from the scrolled viewport instead ([30, -50, 0, 0, 5, 1974], Firefox 1975), and the spec wins.
  it "measures x and y off the image's first box in the viewport" do
    page = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body style="margin:0">
      <div style="height:50px"></div>
      <img id=a width=20 height=20 style="margin-left:30px;transform:translate(7px,9px)">
      <div style="height:2000px"></div>
      <img id=b width=20 height=20 style="display:none">
      <span style="position:relative;left:5px"><img id=c width=20 height=20></span>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
    got = session.evaluate_script(<<~JS)
      (() => {
        scrollTo(0, 100);
        Element.prototype.getBoundingClientRect = () => ({left: 999, top: 999});
        const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id));
        return [a.x, a.y, b.x, b.y, c.x, c.y];
      })()
    JS
    expect(got).to eq([30, 50, 0, 0, 5, 2074])
  end
  # A decode waits on the CURRENT request: a new one started, or the source removed, rejects it (HTML `decode()`;
  # Chrome: EncodingError for each).
  it 'rejects a pending decode() when the current request changes' do
    session = simulated_session(app).tap {|s| s.visit '/' }
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const swapped = new Image(), removed = new Image();
      swapped.src = '/green?a';
      const a = swapped.decode();
      swapped.src = '/green?b';
      removed.src = '/green?c';
      const b = removed.decode();
      removed.removeAttribute('src');
      Promise.all([a, b].map((p) => p.then(() => 'ok', (e) => e.name))).then(done);
    JS
    expect(got).to eq(%w[EncodingError EncodingError])
  end
  # A `blob:` image loads from the blob the page made — a file input's preview's shape — and a revoked one, or one of a
  # scheme nothing fetches (`ftp:`), is broken: its `error` fired and its decode rejected. Chrome: the same log.
  it 'loads a blob: image from its blob, and breaks one nothing can fetch' do
    session = simulated_session(app).tap {|s| s.visit '/' }
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGNgYGD4z8DAwMDAAAAQAAH/0XvFsQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const blob = () => URL.createObjectURL(new Blob([bytes], {type: 'image/png'}));
      const [ok, ftp, revoked] = [new Image(), new Image(), new Image()];
      const ev = (img, name) => new Promise((r) => {
        img.onload = () => r(name + ':load:' + img.naturalWidth + 'x' + img.naturalHeight);
        img.onerror = () => r(name + ':error');
      });
      const waits = [ev(ok, 'blob'), ev(ftp, 'ftp'), ev(revoked, 'revoked')];
      ok.src = blob();
      ftp.src = 'ftp://example.com/x.png';
      const gone = blob();
      URL.revokeObjectURL(gone);
      revoked.src = gone;
      const decodes = [ok, ftp].map((i) => i.decode().then(() => 'ok', (e) => e.name));
      Promise.all([...waits, ...decodes]).then(done);
    JS
    expect(got).to eq(%w[blob:load:2x3 ftp:error revoked:error ok EncodingError])
  end
end

