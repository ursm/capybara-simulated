# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A canvas's origin-clean flag (HTML §4.12.5.1.2) is cleared by drawing a source that is not origin-clean, and nothing
# sets it again: not `restore()`, not `reset()` ("reset the rendering context to its default state" has no step for it),
# and not a resize — the spec and Firefox, where Chrome cleans the bitmap on a resize (measured: `drawn:SecurityError
# restore:SecurityError reset:SecurityError resize:clean`; Firefox SecurityError throughout).
RSpec.describe 'canvas origin-clean flag' do
  let(:png) { File.binread(File.expand_path('wpt/images/green-1x1.png', __dir__)) }

  it 'stays cleared through restore(), reset() and a resize' do
    app = ->(env) {
      if env['PATH_INFO'] == '/a.png'
        [200, {'content-type' => 'image/png'}, [png]]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body></body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], r = [];
      const read = (c) => { try { c.toDataURL(); return 'clean'; } catch (e) { return e.name; } };
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const g = c.getContext('2d');
        r.push(read(c));
        g.save();
        g.drawImage(img, 0, 0);
        r.push(read(c));
        g.restore();
        r.push(read(c));
        g.reset();
        r.push(read(c));
        c.width = 10;
        r.push(read(c));
        const fresh = document.createElement('canvas');
        fresh.getContext('2d').drawImage(c, 0, 0);
        r.push(read(fresh));
        done(r);
      };
      img.src = 'http://other.test/a.png';
    JS
    expect(got).to eq(%w[clean SecurityError SecurityError SecurityError SecurityError SecurityError])
  end
  # What clears it is the image's RESPONSE not being CORS-same-origin — a no-cors one any hop of which left the
  # document's origin (Fetch's response tainting stays opaque) — whatever origin the image's URL is of: a same-origin URL
  # redirected to another origin taints, a cross-origin one redirected back taints, a CORS one through it does not.
  it 'is cleared by the response an image is, not its URL' do
    app = ->(env) {
      case [env['SERVER_NAME'], env['PATH_INFO']]
      in [_, '/away.png'] then [302, {'location' => "http://other.test/a.png?#{env['QUERY_STRING']}"}, []]
      in ['other.test', '/back.png'] then [302, {'location' => 'http://www.example.com/a.png'}, []]
      in [_, '/a.png'] then [200, {'content-type' => 'image/png', 'access-control-allow-origin' => '*'}, [png]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body></body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const read = (src, cors) => new Promise((resolve) => {
        const img = new Image();
        if (cors) img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.getContext('2d').drawImage(img, 0, 0);
          try { c.toDataURL(); resolve('clean'); } catch (e) { resolve(e.name); }
        };
        img.onerror = () => resolve('error');
        img.src = src;
      });
      Promise.all([read('/a.png'), read('/away.png'), read('/away.png?cors', true), read('http://other.test/back.png')]).then(done);
    JS
    expect(got).to eq(%w[clean SecurityError clean SecurityError])
  end
  # …and the origin it is judged by is the drawing document's: an about:blank one's its creator's however deep — a frame
  # of another origin's, so that origin's image draws clean there — and a sandboxed one's opaque, so even its own host's
  # video taints.
  it 'is judged by the origin the document has' do
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin's frame served in-process
    video = File.binread(File.expand_path('wpt/media/2x2-green.webm', __dir__))
    probe = <<~JS
      const report = (what, c) => { try { c.toDataURL(); parent.postMessage([what, 'clean'], '*'); } catch (e) { parent.postMessage([what, e.name], '*'); } };
    JS
    blank = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        #{probe}
        const f = document.createElement('iframe');
        document.body.append(f);
        const w = f.contentWindow, img = new w.Image();
        img.onload = () => {
          const c = w.document.createElement('canvas');
          c.getContext('2d').drawImage(img, 0, 0);
          report('blank', c);
        };
        img.src = 'http://other.test/a.png';
      </script>
    HTML
    sandboxed = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        #{probe}
        const v = document.createElement('video');
        v.onloadeddata = () => { const c = document.createElement('canvas'); c.getContext('2d').drawImage(v, 0, 0); report('sandboxed', c); };
        v.onerror = () => parent.postMessage(['sandboxed', 'error'], '*');
        v.src = '/v.webm';
        document.body.append(v);
      </script>
    HTML
    app = ->(env) {
      case env['PATH_INFO']
      when '/a.png' then [200, {'content-type' => 'image/png'}, [png]]
      when '/v.webm' then [200, {'content-type' => 'video/webm'}, [video]]
      when '/blank.html' then [200, {'content-type' => 'text/html'}, [blank]]
      when '/sandboxed.html' then [200, {'content-type' => 'text/html'}, [sandboxed]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body></body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], got = {};
      addEventListener('message', (e) => { got[e.data[0]] = e.data[1]; if (Object.keys(got).length === 2) done(got); });
      const a = document.createElement('iframe');
      a.src = 'http://other.test/blank.html';
      const b = document.createElement('iframe');
      b.sandbox = 'allow-scripts';
      b.src = '/sandboxed.html';
      document.body.append(a, b);
    JS
    expect(got).to eq('blank' => 'clean', 'sandboxed' => 'SecurityError')
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end
end

