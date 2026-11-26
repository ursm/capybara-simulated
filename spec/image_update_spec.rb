# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML "update the image data" (image_requests.rs): an image's `load` and `error` are element tasks — never a microtask
# — its new request pending while the current one still shows, the list of available images taking a source it holds
# at once, and the server's time a response took counted on the event loop's clock. Chrome and Firefox (csim-bench img13
# `i1`–`i7`, 2026-11-27) where noted.
RSpec.describe 'update the image data' do
  include PollUntil

  png    = File.binread(File.join(__dir__, 'wpt/images/anim-gr.png'))
  small  = File.binread(File.join(__dir__, 'wpt/images/green-1x1.png'))

  def image_session(png, small, requests = [])
    app = lambda {|env|
      path = env['PATH_INFO']
      requests << path unless path == '/'
      case path
      when '/'       then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      when '/a.png'  then [200, {'content-type' => 'image/png', 'cache-control' => 'no-store'}, [png]]
      when '/b.png'  then [200, {'content-type' => 'image/png', 'cache-control' => 'no-store'}, [small]]
      when '/slow.png'
        sleep 0.1
        [200, {'content-type' => 'image/png', 'cache-control' => 'no-store'}, [small]]
      else [404, {'content-type' => 'text/plain'}, ['']]
      end
    }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  # Chrome and Firefox both: `A:t0` before `A load` — a `data:` image's `load`, and a missing one's `error`, are tasks
  # queued behind a timer set before the source was.
  it 'fires load and error from element tasks, after a timer queued before them' do
    s = image_session(png, small)
    s.execute_script(<<~JS)
      window.log = [];
      const a = new Image(), b = new Image();
      a.onload = () => log.push('a load');
      b.onerror = () => log.push('b error');
      setTimeout(() => log.push('t0'), 0);
      a.src = 'data:image/png;base64,#{[small].pack('m0')}';
      b.src = '/missing.png';
      Promise.resolve().then(() => log.push('micro'));
    JS
    poll_until { s.evaluate_script('log.length') >= 4 }
    expect(s.evaluate_script('log')).to eq(['micro', 't0', 'a load', 'b error'])
  end

  # A new request is pending while the current one is completely available: `complete` false at once, the current
  # image's natural size and URL read until the new one's `load` (Firefox, HTML; Chrome drops them at once), and an
  # empty `src` makes it complete with an `error` (both).
  it 'keeps the current image while a new request is pending, and errs on an empty src' do
    s = image_session(png, small)
    s.execute_script(<<~'JS')
      window.log = [];
      const i = window.i = new Image();
      const read = () => [i.complete, i.naturalWidth, i.currentSrc.split('/').pop()].join();
      i.onload = () => {
        if (log.length) { log.push('load ' + read()); i.onload = null; i.src = ''; log.push('empty ' + read()); return; }
        log.push('first ' + read());
        i.src = '/b.png';
        log.push('sync ' + read());
        Promise.resolve().then(() => log.push('micro ' + read()));
      };
      i.onerror = () => log.push('error ' + read());
      i.src = '/a.png';
    JS
    poll_until { s.evaluate_script('log.length') >= 6 }
    expect(s.evaluate_script('log')).to eq([
      'first true,100,a.png', 'sync false,100,a.png', 'micro false,100,a.png', 'load true,1,b.png',
      'empty true,0,', 'error true,0,'
    ])
  end

  # The list of available images: a second image of a URL the first loaded is complete with its size at once — its
  # response's `no-store` notwithstanding ("ignore higher-layer caching", Chrome) — and fires `load` as a task, nothing
  # fetched again; an `src` set to the value it had fires `load` again (Chrome and Firefox).
  it 'takes a source the list of available images holds at once' do
    requests = []
    s = image_session(png, small, requests)
    s.execute_script(<<~'JS')
      window.log = [];
      const a = window.a = new Image();
      a.onload = () => {
        a.onload = () => log.push('again');
        const b = new Image();
        b.onload = () => log.push('b load');
        b.src = '/a.png';
        log.push('b ' + b.complete + ' ' + b.naturalWidth);
        a.src = '/a.png';
      };
      a.src = '/a.png';
    JS
    poll_until { s.evaluate_script('log.length') >= 3 }
    expect(s.evaluate_script('log')).to eq(['b true 100', 'b load', 'again'])
    expect(requests).to eq(['/a.png'])
  end

  # A `decode()` of an image whose request turns out broken is rejected ahead of its `error` (Chrome and Firefox).
  it 'rejects a decode of a broken image ahead of its error' do
    s = image_session(png, small)
    s.execute_script(<<~'JS')
      window.log = [];
      const j = new Image();
      j.onerror = () => log.push('error');
      j.src = '/missing.png';
      j.decode().catch((e) => log.push('rejected ' + e.name));
    JS
    poll_until { s.evaluate_script('log.length') >= 2 }
    expect(s.evaluate_script('log')).to eq(['rejected EncodingError', 'error'])
  end

  # The time its server took (an app's `sleep`) lands a response that far after its fetch began, on the event loop's
  # clock: before a later timer, its `load` holding the document's.
  it 'lands a response as far after its fetch began as its server took' do
    s = image_session(png, small)
    s.execute_script(<<~'JS')
      window.log = [];
      const i = new Image(), t = performance.now();
      i.onload = () => log.push('load ' + (performance.now() - t >= 100));
      i.src = '/slow.png';
      setTimeout(() => log.push('t700'), 700);
    JS
    poll_until { s.evaluate_script('log.length') >= 2 }
    expect(s.evaluate_script('log')).to eq(['load true', 't700'])
  end

  # HTML lazy loading: an `<img loading=lazy>` below the fold is fetched once it nears the viewport, the page's `load`
  # never waiting for it (Chrome and Firefox; Chrome fetches nothing before, csim-bench img13 `i9`).
  it 'puts a lazy image off until it nears the viewport, the load waiting for none' do
    requests = []
    s = image_session(png, small, requests)
    s.execute_script(<<~'JS')
      window.log = [];
      document.body.innerHTML = '<div style="height: 5000px"></div><img id=lazy loading=lazy src="/b.png">';
      lazy.onload = () => log.push('lazy load');
    JS
    s.evaluate_script('new Promise((r) => setTimeout(r, 200))')
    expect([s.evaluate_script('[log.join(), lazy.complete]'), requests]).to eq([['', false], []])
    s.execute_script('lazy.scrollIntoView()')
    poll_until { s.evaluate_script('log.length') >= 1 }
    expect(requests).to eq(['/b.png'])
  end

  # `sizes` gives the width-described candidates their density: at an 800px viewport, `sizes="(min-width: 600px) 25vw"`
  # is 200px, so a `400w` is 2x and a `200w` 1x — the 1x taken (HTML "parse a sizes attribute").
  it 'selects among width descriptors by the source size sizes gives' do
    s = image_session(png, small)
    s.current_window.resize_to(800, 600)
    s.execute_script(<<~'JS')
      window.log = [];
      const i = new Image();
      i.sizes = '(min-width: 600px) 25vw, 100vw';
      i.srcset = '/a.png 400w, /b.png 200w';
      i.onload = () => log.push(i.currentSrc.split('/').pop());
    JS
    poll_until { s.evaluate_script('log.length') >= 1 }
    expect(s.evaluate_script('log')).to eq(['b.png'])
  end

  # An image the list of available images takes decodes, its `currentSrc` its URL at once (Chrome and Firefox, rv `dec`).
  it 'decodes an image the list of available images takes' do
    s = image_session(png, small)
    s.execute_script(<<~'JS')
      window.log = [];
      const a = new Image();
      a.onload = () => {
        const b = new Image();
        b.src = '/a.png';
        log.push(b.currentSrc.split('/').pop());
        b.decode().then(() => log.push('decoded'), (e) => log.push(e.name));
      };
      a.src = '/a.png';
    JS
    poll_until { s.evaluate_script('log.length') >= 2 }
    expect(s.evaluate_script('log')).to eq(['a.png', 'decoded'])
  end

  # A page's images are fetched at once, beside each other, as a browser fetches them: ten whose server takes 200 ms each
  # load in about 200 ms of real time, not two seconds — each landing 200 ms after it began on the clock all the same.
  it "fetches a page's images at once, each landing at its server's time" do
    slow = File.binread(File.join(__dir__, 'wpt/images/green-1x1.png'))
    app = lambda {|env|
      next [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{(0...10).map {|i| "<img src=/s#{i}.png>" }.join}"]] if env['PATH_INFO'] == '/'

      sleep 0.2
      [200, {'content-type' => 'image/png'}, [slow]]
    }
    s = simulated_session(app)
    t = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    s.visit '/'
    expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - t).to be < 1.2
    expect(s.evaluate_script('[...document.images].every((i) => i.complete && i.naturalWidth === 1)')).to be true
    expect(s.evaluate_script('performance.now()')).to be >= 200
  end

  # A lazy image in a frame the top-level viewport is far from waits for the frame to near it (Chrome and Firefox, rv
  # `lazy2`); `sizes=auto` sizes an image 300x150 by the UA sheet's size containment (both).
  it "takes a frame's place in the page for its lazy images, and sizes an auto-sized image 300 wide" do
    requests = []
    s = image_session(png, small, requests)
    s.execute_script(<<~'JS')
      window.log = [];
      document.body.style.margin = '0';
      document.body.innerHTML = '<img id=auto sizes="auto, 50px" srcset="/a.png 100w"><div style="height: 6000px"></div><iframe id=far></iframe>';
      far.srcdoc = '<img loading=lazy src="/b.png" onload="parent.log.push(1)">';
    JS
    s.evaluate_script('new Promise((r) => setTimeout(r, 300))')
    expect([s.evaluate_script('[log.length, auto.width]'), requests.include?('/b.png')]).to eq([[0, 300], false])
    s.execute_script('far.scrollIntoView()')
    poll_until { s.evaluate_script('log.length') >= 1 }
    expect(requests).to include('/b.png')
  end
end
