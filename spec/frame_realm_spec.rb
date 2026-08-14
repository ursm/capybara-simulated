require 'capybara/simulated'
require_relative 'support/js_engine'
require_relative 'support/session_teardown'

# Frame-document scripts must execute in the FRAME's realm, whichever
# execution path the runtime routes them through. The leading-lexical and
# ≥64KB bodies go to Ruby host fns (shared-lexical eval / bytecode cache),
# and `type=module` to the native module loader — each of those is
# context-bound, so a main-ctx-bound variant replayed onto the realm would
# run the frame's script against the PARENT document (regression: the
# rusty_racer migration's realm replay did exactly that).
RSpec.describe 'iframe inline-script realm routing' do
  before do
    # Per-frame realms are a V8 (rusty_racer) feature; QuickJS keeps the
    # same-realm fallback by design.
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?
  end

  let(:big_pad) { "// #{'x' * 70_000}\n" }

  let(:app) {
    pad = big_pad
    lambda do |env|
      case env['PATH_INFO']
      when '/frame-lexical'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script>const marker = 'IFRAME-LEXICAL'; document.title = marker;</script></body></html>
        HTML
      when '/frame-plain'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script>document.title = 'IFRAME-PLAIN';</script></body></html>
        HTML
      when '/frame-big'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script>document.title = 'IFRAME-BIG';
          #{pad}</script></body></html>
        HTML
      when '/frame-module'
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>FRAMETITLE</title></head>
          <body><script type="module">document.title = 'IFRAME-MODULE';</script></body></html>
        HTML
      else
        frame = env['PATH_INFO'].sub('/main', '/frame')
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><head><title>MAIN</title></head>
          <body><iframe src="#{frame}"></iframe></body></html>
        HTML
      end
    end
  }
  let(:session) { simulated_session(app) }

  def titles_after_visit(path)
    session.visit path
    # Force the frame realm to build + load (contentWindow getter).
    frame_title = session.evaluate_script(
      "document.querySelector('iframe').contentWindow.document.title"
    )
    parent_title = session.evaluate_script('document.title')
    {parent: parent_title, frame: frame_title}
  end

  it 'plain (non-lexical) inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-plain')).to eq(parent: 'MAIN', frame: 'IFRAME-PLAIN')
  end

  it 'leading-lexical inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-lexical')).to eq(parent: 'MAIN', frame: 'IFRAME-LEXICAL')
  end

  it 'big (>=64KB) inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-big')).to eq(parent: 'MAIN', frame: 'IFRAME-BIG')
  end

  it 'module inline script runs in the iframe realm' do
    expect(titles_after_visit('/main-module')).to eq(parent: 'MAIN', frame: 'IFRAME-MODULE')
  end
end

# Same-origin policy on iframe `contentDocument`: a frame is reachable only when
# it is same-origin with the accessing document. A cross-origin frame (different
# host) and a sandboxed frame (opaque origin) expose a WindowProxy via
# `contentWindow` but a null `contentDocument`.
RSpec.describe 'iframe contentDocument same-origin policy' do
  before { skip 'per-frame realms need the V8 engine' unless CsimEngine.v8? }

  let(:app) {
    lambda do |env|
      body = env['PATH_INFO'] == '/child' ? '<!doctype html><html><body>CHILD</body></html>' : '<!doctype html><html><body>ROOT</body></html>'
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  def content_doc_reachable(frame_html)
    session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe');
        #{frame_html}
        document.body.appendChild(f);
        return !!f.contentDocument;
      })()
    JS
  end

  it 'exposes a same-origin frame document' do
    expect(content_doc_reachable("f.src = '/child';")).to be(true)
  end

  it 'hides a cross-origin (different-host) frame document' do
    expect(content_doc_reachable("f.src = 'http://cross.example.org/child';")).to be(false)
  end

  it 'hides a sandboxed frame document (opaque origin)' do
    expect(content_doc_reachable("f.setAttribute('sandbox', ''); f.src = '/child';")).to be(false)
  end
end

# Same-origin policy on the cross-origin WindowProxy itself: a cross-origin
# Window exposes only the "CrossOriginProperties" (postMessage / location /
# closed / frames / top / parent / …); reading anything else (notably
# `document`) throws SecurityError. The same get-trap governs BOTH directions —
# a parent reading a cross-origin child AND a cross-origin child reading its
# parent / top.
RSpec.describe 'cross-origin WindowProxy same-origin policy' do
  before { skip 'per-frame realms need the V8 engine' unless CsimEngine.v8? }

  let(:app) {
    lambda do |env|
      if env['PATH_INFO'].include?('child')
        # A cross-origin child reports its OWN origin (always readable) and whether
        # reading the TOP window's `origin` throws — `origin` is NOT a cross-origin-safe
        # WindowProxy property, so a cross-origin child must get a SecurityError. Reported
        # via the always-allowed postMessage.
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><meta charset=utf-8><script>
            function probe(fn) { try { return 'ok:' + typeof fn(); } catch (e) { return e.name; } }
            parent.postMessage(
              'self=' + self.origin +
              ' topOrigin=' + probe(function () { return top.origin; }) +
              ' parentDoc=' + probe(function () { return parent.document; }), '*');
          </script>
        HTML
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>ROOT</body>']]
      end
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  # Read `prop` off a freshly-appended cross-origin frame's contentWindow.
  def cross_window_get(prop)
    session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe');
        f.src = 'http://cross.example.org/child';
        document.body.appendChild(f);
        try { const v = f.contentWindow.#{prop}; return 'ok:' + (typeof v); }
        catch (e) { return e.name; }
      })()
    JS
  end

  # Evaluate `expr` (a JS expression given `w` = the cross-origin frame's contentWindow),
  # returning `ok:<typeof>` or the thrown error's name.
  def cross_window_eval(expr)
    session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe');
        f.src = 'http://cross.example.org/child';
        document.body.appendChild(f);
        const w = f.contentWindow;
        try { return 'ok:' + (typeof (#{expr})); }
        catch (e) { return e.name; }
      })()
    JS
  end

  it 'throws SecurityError reading document on a cross-origin frame' do
    expect(cross_window_get('document')).to eq('SecurityError')
  end

  it 'exposes the cross-origin-safe properties without throwing (postMessage, closed)' do
    # The point is that an allowlisted property is READABLE cross-origin (no
    # SecurityError), unlike `document`. (`closed` is accessible though not yet a
    # real boolean — a separate, non-SOP gap.)
    expect(cross_window_get('postMessage')).to eq('ok:function')
    expect(cross_window_get('closed')).to start_with('ok:')
  end

  # (b) A cross-origin Location: the object itself is reachable (`location` is a
  # cross-origin Window property), but only its `href` setter + `replace()` work —
  # every getter (href, protocol, …) and `assign` throws SecurityError, so the URL
  # never leaks cross-origin.
  it 'SOP-gates a cross-origin Location to href-setter + replace only' do
    expect(cross_window_get('location')).to eq('ok:object')     # the Location object is reachable
    expect(cross_window_eval('w.location.replace')).to eq('ok:function')  # replace() allowed
    expect(cross_window_eval('w.location.href')).to eq('SecurityError')   # href GETTER blocked
    expect(cross_window_eval('w.location.protocol')).to eq('SecurityError')
    expect(cross_window_eval('w.location.assign')).to eq('SecurityError') # assign not cross-origin
  end

  # (c) `[[Has]]` / `[[GetOwnProperty]]` are SOP-gated too, so a probe can't enumerate
  # the same-origin surface: `'document' in frame` is false, a descriptor probe throws,
  # and a cross-origin-safe name still answers present.
  it 'SOP-gates has / getOwnPropertyDescriptor on a cross-origin window' do
    expect(cross_window_eval("'document' in w")).to eq('ok:boolean')            # returns a value…
    expect(session.evaluate_script(<<~JS)).to eq(false)                          # …and it is false
      (function () {
        const f = document.createElement('iframe'); f.src = 'http://cross.example.org/child';
        document.body.appendChild(f); return 'document' in f.contentWindow;
      })()
    JS
    expect(cross_window_eval("'postMessage' in w")).to eq('ok:boolean')
    expect(cross_window_eval('Object.getOwnPropertyDescriptor(w, "document")')).to eq('SecurityError')
    # A sensitive (configurable) own property name is hidden from enumeration too.
    hidden = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe'); f.src = 'http://cross.example.org/child';
        document.body.appendChild(f);
        return Object.getOwnPropertyNames(f.contentWindow).includes('document');
      })()
    JS
    expect(hidden).to eq(false)
  end

  it 'allows full access to a same-origin frame window' do
    same = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe');
        f.src = '/child';
        document.body.appendChild(f);
        try { return f.contentWindow.document ? 'doc' : 'null'; }
        catch (e) { return e.name; }
      })()
    JS
    expect(same).to eq('doc')
  end

  # The REVERSE direction (child → parent/top), closed by the observer-origin-keyed SOP
  # memo. A cross-origin child reads its OWN origin fine, but `top.origin` (not a
  # cross-origin-safe property) and `parent.document` both throw SecurityError — the same
  # SOP as the forward direction. Previously a stale same-origin memo (captured while the
  # child still had its inherited about:blank origin) left these readable for the frame's
  # life. (A cross-origin-aware API like showPicker detects the embedding via the
  # driver-internal raw-window unwrap, not web `top.origin`.)
  it 'gives a cross-origin child SecurityError on top.origin / parent.document, not its own origin' do
    session.evaluate_script(<<~JS)
      window.__r = 'none';
      window.addEventListener('message', (e) => { window.__r = e.data; });
      const f = document.createElement('iframe');
      f.src = 'http://cross.example.org/child';
      document.body.appendChild(f);
      void f.contentWindow;   // cross-origin frames build lazily — force the load
    JS
    r = nil
    20.times do
      r = session.evaluate_script('window.__r')
      break if r != 'none'
      sleep 0.02
    end
    expect(r).to eq('self=http://cross.example.org topOrigin=SecurityError parentDoc=SecurityError')
  end
end

# postMessage targetOrigin gating + event.origin (HTML "window post message").
RSpec.describe 'postMessage cross-document origin' do
  before { skip 'per-frame realms need the V8 engine' unless CsimEngine.v8? }

  let(:app) {
    lambda do |env|
      if env['PATH_INFO'].include?('child')
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><meta charset=utf-8><script>
            parent.postMessage('star', '*');
            parent.postMessage('match', location.origin);
            parent.postMessage('mismatch', 'http://wrong.example.org');
          </script>
        HTML
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>ROOT</body>']]
      end
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'delivers only matching-targetOrigin messages and sets event.origin to the sender' do
    session.evaluate_script(<<~JS)
      window.__msgs = [];
      window.addEventListener('message', (e) => { window.__msgs.push(e.data + '@' + e.origin); });
      const f = document.createElement('iframe');
      f.src = '/child';
      document.body.appendChild(f);
      void f.contentWindow;
    JS
    msgs = []
    20.times do
      msgs = session.evaluate_script('window.__msgs')
      break if msgs.length >= 2
      sleep 0.02
    end
    # "star" (*) and "match" (origin equals target) delivered; "mismatch" dropped.
    # event.origin is the sender's origin, not ''.
    expect(msgs).to contain_exactly(
      'star@http://www.example.com',
      'match@http://www.example.com'
    )
  end

  # A reference still held to a REMOVED iframe's window (its realm is disposed) must
  # stay safe to call: a detached Window's `setTimeout` is an inert stub — returns a
  # numeric id, schedules nothing — not a throw. Without the neuter, `w.setTimeout`
  # routes to a host fn that died with the context → "unknown host function".
  # (html/webappapis/timers/settimeout-detached-iframe.html's detached half.)
  it 'a detached iframe window keeps setTimeout callable + inert (no throw)' do
    result = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('iframe');
        document.body.appendChild(f);
        const w = f.contentWindow;   // build the realm
        f.remove();                  // dispose it; `w` lives on
        let threw = false, id;
        try { id = w.setTimeout(() => {}, 0); } catch (e) { threw = true; }
        return { threw, idType: typeof id, contentWindowNull: f.contentWindow === null };
      })()
    JS
    expect(result).to eq('threw' => false, 'idType' => 'number', 'contentWindowNull' => true)
  end

  # A same-origin child shares the parent's event loop, so a child's 0 ms timer
  # interleaves WITH the parent's tasks — it must fire before the parent's nested
  # `setTimeout(0)` chain has finished, not after the whole chain drains. (Same
  # contract as settimeout-detached-iframe's attached half.)
  it "an attached child frame's 0ms timer fires within the parent's nested timer chain" do
    session.evaluate_script(<<~JS)
      window.__attachedRan = false;
      const f = document.createElement('iframe');
      document.body.appendChild(f);
      f.contentWindow.setTimeout(() => { window.__attachedRan = true; }, 0);
      setTimeout(() => {
        // By this inner tick the child's co-scheduled 0ms timer must have run.
        setTimeout(() => { window.__attachedRanAtInner = window.__attachedRan; }, 0);
      }, 0);
    JS
    ran = nil
    20.times do
      ran = session.evaluate_script('window.__attachedRanAtInner')
      break unless ran.nil?
      sleep 0.02
    end
    expect(ran).to be(true)
  end
end

# An inline `<script>`'s completion value is nobody's answer, but the two Ruby-side
# execution paths (leading-lexical → shared-lexical eval; ≥64KB → bytecode cache)
# used to hand it back across the V8→Ruby boundary, where rusty_racer marshals it —
# and marshalling RUNS JS. A script ending in an expression whose read throws (a
# getter, a Proxy trap) therefore FAILED after running to completion: the bridge
# saw the raise, fired the script's `error` event and reported `_ok=false`, for a
# value nobody wanted. `eval_void` / `run_void` don't read it at all.
#
# The same mechanism took out iframe building entirely (the frame boot eval
# evaluates to the parent's WindowProxy, whose `ownKeys` trap throws SecurityError
# at a cross-origin parent) — that path needs the WPT service-worker corpus, which
# is vendored but not gated, so this pins the class of bug where the suite can see it.
RSpec.describe 'inline script with a hostile completion value' do
  before { skip 'the Ruby-side script paths are V8-only' unless CsimEngine.v8? }

  # `const` first → the shared-lexical eval path. The 70KB pad pushes the second
  # one past SCRIPT_CACHE_MIN_BYTES → the compile + bytecode-cache path.
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset=utf-8><body><script>
          // A parser-inserted script that throws is reported to the console
          // ("[csim] script threw in …"), so that is what proves it ran clean.
          window.__errors = [];
          const __ce = console.error;
          console.error = function () { window.__errors.push(String(arguments[0])); __ce.apply(console, arguments); };
        </script>
        <script>
          const lexical = 'ran';
          window.__lexical = lexical;
          new Proxy({}, {ownKeys() { throw new Error('completion boom'); }});
        </script>
        <script>
          // #{'x' * 70_000}
          window.__big = 'ran';
          new Proxy({}, {ownKeys() { throw new Error('completion boom'); }});
        </script></body>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  it 'runs to completion and reports no error' do
    session.visit '/'
    expect(session.evaluate_script('window.__lexical')).to eq('ran')
    expect(session.evaluate_script('window.__big')).to eq('ran')
    expect(session.evaluate_script('window.__errors')).to eq([])
  end
end
