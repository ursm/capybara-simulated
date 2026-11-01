require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML "unload a document and its descendants": a navigation that replaces the page's document fires its `pagehide`
# and `unload` — and its frames' — while its realms still live, so what their handlers do (a beacon, a storage write)
# is done. (The page's own teardown never ran: only a frame's, and a closed window's.)
RSpec.describe 'unloading the page as a navigation replaces it' do
  it "runs the page's and its frames' pagehide and unload handlers" do
    beacons = []
    app = lambda do |env|
      beacons << env['PATH_INFO'] if env['REQUEST_METHOD'] == 'POST'
      body = case env['PATH_INFO']
             when '/a' then <<~HTML
               <iframe src="/frame"></iframe><script>
                 addEventListener('pagehide', (e) => { localStorage.setItem('pagehide', String(e.persisted)) });
                 addEventListener('unload', () => navigator.sendBeacon('/page-unload', 'x'));
               </script>
             HTML
             when '/frame' then "<script>addEventListener('unload', () => navigator.sendBeacon('/frame-unload', 'x'))</script>"
             else '<p>after</p>'
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/a'
    s.execute_script("location = '/after'")
    poll_until { s.evaluate_script('location.pathname') == '/after' && beacons.size == 2 }

    expect(beacons.sort).to eq(%w[/frame-unload /page-unload])
    expect(s.evaluate_script("localStorage.getItem('pagehide')")).to eq('false')
    s.visit '/a'
    beacons.clear
    s.visit '/after'
    poll_until { beacons.size == 2 }

    expect(beacons.sort).to eq(%w[/frame-unload /page-unload])
  end

  # …asked first whether it may be (HTML "navigate": "check if unloading is canceled"), before its next document is
  # fetched — `beforeunload` at it, then at its frames' — a handler's navigation ignored meanwhile; and the navigation
  # goes on whatever a handler says, as one who confirmed the prompt would have it.
  it "asks the page and its frames whether they may be unloaded before the navigation's fetch" do
    events = []
    app = lambda do |env|
      events << "fetch #{env['PATH_INFO']}" unless env['PATH_INFO'] == '/frame'
      body = case env['PATH_INFO']
             when '/a' then <<~HTML
               <iframe src="/frame"></iframe><script>
                 addEventListener('beforeunload', (e) => {
                   navigator.sendBeacon('/beacon-page-beforeunload');
                   location.href = '/evil';
                   e.preventDefault();
                 });
               </script>
             HTML
             when '/frame' then "<script>addEventListener('beforeunload', () => navigator.sendBeacon('/beacon-frame-beforeunload'))</script>"
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/a'
    events.clear
    s.visit '/b'

    expect(events).to eq(['fetch /beacon-page-beforeunload', 'fetch /beacon-frame-beforeunload', 'fetch /b'])
    expect(s).to have_current_path('/b')
  end

  # …as a traversal applies its step, what a handler does to the session history ignored: the step stands (Chrome and
  # Firefox: back to /a, forward to /b again).
  it "asks the page as a traversal applies its step, which its handlers do not move" do
    app = lambda do |env|
      body = env['PATH_INFO'] == '/b' ? "<script>addEventListener('beforeunload', () => history.pushState(null, '', '/pushed'))</script>b" : 'a'
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/a'
    s.visit '/b'
    s.go_back
    expect(s).to have_current_path('/a')
    s.go_forward
    expect(s).to have_current_path('/b')
  end

  # …and a frame's, as a traversal applies a step that makes its document again, the same way (Chrome and Firefox: back
  # to /f1, forward to /f2 again).
  it "asks a frame as a traversal applies its step, which its handlers do not move" do
    app = lambda do |env|
      body = case env['PATH_INFO']
             when '/top' then '<iframe src="/f1"></iframe>'
             when '/f2' then "<script>addEventListener('beforeunload', () => history.pushState(null, '', '/f2-pushed'))</script>f2"
             else 'f1'
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/top'
    s.execute_script("frames[0].location = '/f2'")
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f2' }
    s.go_back
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f1' }
    s.go_forward

    expect(poll_until { s.evaluate_script('frames[0].location.pathname').then {|p| p if p == '/f2' } }).to eq('/f2')
  end

  # …once: a traversal to its about:blank entry, made as a navigation to it is, asks it no second time.
  it "asks a frame once as a traversal goes to its about:blank entry" do
    beacons = []
    app = lambda do |env|
      beacons << env['PATH_INFO'] if env['REQUEST_METHOD'] == 'POST'
      body = env['PATH_INFO'] == '/top' ? '<iframe src="/f1"></iframe>' : "<script>addEventListener('beforeunload', () => navigator.sendBeacon('/bu-f1'))</script>f1"
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/top'
    s.execute_script("frames[0].location = 'about:blank'")
    poll_until { s.evaluate_script('frames[0].location.href') == 'about:blank' }
    s.go_back
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f1' }
    beacons.clear
    s.go_forward
    poll_until { s.evaluate_script('frames[0].location.href') == 'about:blank' }

    expect(beacons).to eq(%w[/bu-f1])
  end

  # …and a hyperlink or a form a handler navigates it with ignored, as a `location` navigation is — not taken once the
  # navigation asking it ends in no document (a 204), whose page stays (Chrome and Firefox request neither).
  it "ignores a hyperlink or a form a beforeunload handler navigates the page with" do
    seen = []
    app = lambda do |env|
      seen << env['PATH_INFO']
      next [204, {}, []] if env['PATH_INFO'] == '/nc'

      body = <<~HTML
        <a id="l" href="/evil-link">l</a><a id="h" href="#x">h</a><form id="f" action="/evil-form" method="post"></form>
        <script>addEventListener('beforeunload', () => { h.click(); l.click(); f.submit() })</script>
      HTML
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/a'
    s.execute_script("location.href = '/nc'")
    s.execute_script('setTimeout(() => window.settled = true, 50)')
    poll_until { s.evaluate_script('window.settled === true') }

    expect(seen).to eq(%w[/a /nc])
    expect(s.evaluate_script('location.hash')).to eq('')
  end

  # …and the entry a beforeunload handler pushes as a navigation begins is the session history's: "navigate" asks the
  # document on the traversal queue before the fetch, the entry finalized long before the navigation's (HTML "finalize
  # a same-document navigation") — a pop-up's as the page's (Chrome 156: the step kept, back goes to it, measured
  # 2026-11-01).
  {'the page' => '', 'a pop-up' => 'w.'}.each do |which, on|
    it "keeps the entry #{which}'s beforeunload handler pushes as a navigation begins" do
      app = lambda do |env|
        body = env['PATH_INFO'] == '/a' ? "<script>addEventListener('beforeunload', () => history.pushState(null, '', '/pushed'))</script>a" : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
      end
      s = simulated_session(app)
      s.visit '/a'
      unless on.empty?
        s.execute_script("window.w = open('/a')")
        poll_until { s.evaluate_script('w.document.readyState') == 'complete' }
      end
      s.execute_script("#{on}location = '/b'")
      poll_until { s.evaluate_script("#{on}location.pathname") == '/b' }

      expect(s.evaluate_script("#{on}history.length")).to eq(3)
      s.execute_script("#{on}history.back()")
      poll_until { s.evaluate_script("#{on}location.pathname") != '/b' }
      expect(s.evaluate_script("#{on}location.pathname")).to eq('/pushed')
    end
  end

  # …and a frame's: the entries its beforeunload handler pushes — the frame's own, and its parent's — come before the
  # entry of the navigation that asked it, which its response finalizes after (HTML "navigate"; Chrome 156, Firefox 159
  # and the spec agree, measured 2026-11-01: back goes to both pushed entries, then to the frame's first document).
  {'an http(s) URL' => "'/next'", 'a blob: URL' => "URL.createObjectURL(new Blob(['next'], {type: 'text/html'}))"}.each do |what, to|
    it "keeps the entries a frame's beforeunload handler pushes before its navigation's to #{what}" do
      app = lambda do |env|
        body = case env['PATH_INFO']
               when '/uf' then "<script>addEventListener('beforeunload', () => { history.pushState(null, '', '/uf?bu'); parent.history.pushState(null, '', '/?parent-bu'); });</script>uf"
               when '/next' then 'next'
               else '<iframe id="f" src="/uf"></iframe>'
               end
        [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
      end
      s = simulated_session(app)
      s.visit '/'
      s.execute_script("f.contentWindow.location = #{to}")
      poll_until { s.evaluate_script('f.contentWindow.document.body?.textContent') == 'next' }
      expect(s.evaluate_script('history.length')).to eq(4)
      at = -> { s.evaluate_script('[location.pathname + location.search, f.contentWindow.location.pathname + f.contentWindow.location.search]') }
      steps = Array.new(3) do
        was = at.call
        s.execute_script('history.back()')
        poll_until { at.call != was }
        at.call
      end
      expect(steps).to eq([['/?parent-bu', '/uf?bu'], ['/', '/uf?bu'], ['/', '/uf']])
    end
  end

  # …its unload counter raised as it unloads (HTML): a navigation, a document.write, a dialog of a handler ignored, and
  # what one does to the session history too — its entry, and the URL, the next document's by now — its document hidden
  # after its pagehide (Chrome: pagehide visible, visibilitychange hidden, unload hidden).
  it "ignores what a teardown handler would do to the next document, and hides its own" do
    app = lambda do |env|
      body = case env['PATH_INFO']
             when '/a' then <<~HTML
               <script>
                 const log = [];
                 addEventListener('pagehide', () => { log.push('pagehide ' + document.visibilityState); document.open(); document.write('written'); document.close() });
                 addEventListener('visibilitychange', () => log.push('visibilitychange ' + document.visibilityState));
                 addEventListener('unload', () => {
                   log.push('unload ' + document.visibilityState, 'confirm ' + confirm('c'), 'body ' + document.getElementById('t')?.textContent);
                   history.pushState(null, '', '/pushed');
                   location.hash = 'h';
                   location.href = '/evil';
                   localStorage.setItem('log', JSON.stringify(log));
                 });
               </script><p id="t">a</p>
             HTML
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/a'
    s.visit '/b'

    expect(s.evaluate_script('[location.href, document.body.textContent, history.length]')).to eq(['http://www.example.com/b', '/b', 2])
    expect(JSON.parse(s.evaluate_script("localStorage.getItem('log')"))).to eq(
      ['pagehide visible', 'visibilitychange hidden', 'unload hidden', 'confirm false', 'body a']
    )
    s.go_back
    expect(s).to have_current_path('/a')
  end

  # …as a frame's document is: its own handler re-navigating it is ignored, the navigation unloading it the one that wins
  # (Chrome).
  it "ignores a frame's teardown handler navigating the frame" do
    app = lambda do |env|
      body = case env['PATH_INFO']
             when '/top' then '<iframe src="/f1"></iframe>'
             when '/f1' then "<script>addEventListener('unload', () => { location.href = '/evil' })</script>f1"
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/top'
    s.execute_script("document.querySelector('iframe').src = '/f2'")
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f2' }
    s.execute_script('setTimeout(() => window.settled = true, 50)')
    poll_until { s.evaluate_script('window.settled === true') }

    expect(s.evaluate_script('frames[0].location.pathname')).to eq('/f2')
  end

  # The documents are asked in tree order — the navigable's inclusive descendant navigables, each document's containers
  # in shadow-including tree order (HTML "checking if unloading is canceled", "descendant navigables") — whichever frame's
  # document was made first, and unloaded each after its frames' (HTML "unload a document and its descendants"). Both
  # explicit, both departed from by Chrome 156 and Firefox 159 (measured 2026-11-01): they ask `b` (made first) before
  # `a`, and unload the page first (Chrome: top a c b; Firefox: top b a c). Which of a document's frames unloads first
  # HTML leaves open ("in what order?") and the two disagree: `a` before `b` is our choice, tree order as the prompt's.
  it 'asks the frames in tree order and unloads each after its own frames' do
    log = <<~JS
      const log = (s) => localStorage.setItem('log', (localStorage.getItem('log') || '') + s + ' ');
      addEventListener('beforeunload', () => log('beforeunload:' + name));
      addEventListener('unload', () => log('unload:' + name));
    JS
    app = lambda do |env|
      body = case env['PATH_INFO']
             when '/top' then <<~HTML
               <div id="first"></div><script>
                 #{log}
                 const b = document.createElement('iframe');
                 b.name = 'b';
                 b.src = '/frame';
                 b.onload = () => {
                   const a = document.createElement('iframe');
                   a.name = 'a';
                   a.src = '/outer';
                   a.onload = () => { window.ready = true };
                   document.getElementById('first').append(a);
                 };
                 document.body.append(b);
               </script>
             HTML
             when '/outer' then %(<iframe name="c" src="/frame"></iframe><script>#{log}</script>)
             when '/frame' then "<script>#{log}</script>"
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/top'
    s.execute_script("name = 'top'; localStorage.removeItem('log')")
    poll_until { s.evaluate_script('window.ready === true') }
    s.visit '/after'

    expect(s.evaluate_script("localStorage.getItem('log')").split).to eq(
      %w[
        beforeunload:top
        beforeunload:a
        beforeunload:c
        beforeunload:b
        unload:c
        unload:a
        unload:b
        unload:top
      ]
    )
  end

  # A frame whose own `beforeunload` handler removes it as the page is asked is destroyed once its handlers are done
  # (HTML "destroy a child navigable"; its realm could not go with its script on the stack): its browsing context is
  # discarded by the time the page is unloaded, and none of its own teardown fires.
  it "destroys a frame its own beforeunload handler removed once the prompt has asked it" do
    app = lambda do |env|
      body = case env['PATH_INFO']
             when '/top' then <<~HTML
               <iframe src="/frame"></iframe><script>
                 addEventListener('load', () => { window.held = frames[0] });
                 addEventListener('unload', () => localStorage.setItem('closed', String(window.held.closed)));
               </script>
             HTML
             when '/frame' then <<~HTML
               <script>
                 addEventListener('beforeunload', () => parent.document.querySelector('iframe').remove());
                 addEventListener('unload', () => localStorage.setItem('frame-unload', 'fired'));
               </script>
             HTML
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
    s = simulated_session(app)
    s.visit '/top'
    poll_until { s.evaluate_script('window.held !== undefined') }
    s.execute_script("localStorage.clear()")
    s.visit '/after'

    expect(s.evaluate_script("[localStorage.getItem('closed'), localStorage.getItem('frame-unload')]")).to eq(['true', nil])
  end

  # A walk a call left open — its `finally` never run, as a termination skips it — is ended as the call returns: the
  # document it was asking navigates again.
  # A frame whose unloading has begun — its own frames' unloaded first — and whose container a handler of one of those
  # removes is destroyed with the rest of the tree: its removal leaves it to the unload under way, which skips its own
  # teardown events (its document destroyed, not unloaded) but not its destruction.
  it 'destroys a frame whose container a handler of its own frame removed as the tree unloads' do
    pages = {
      '/top'   => '<iframe src="/r"></iframe>',
      '/r'     => '<iframe src="/a"></iframe>',
      '/a'     => '<iframe src="/c"></iframe>',
      '/c'     => "<script>addEventListener('unload', () => parent.frameElement.remove())</script>"
    }
    app = ->(env) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{pages[env['PATH_INFO']] || env['PATH_INFO']}"]] }
    s = simulated_session(app)
    s.visit '/top'
    poll_until { s.evaluate_script("!!(frames[0] && frames[0].frames[0] && frames[0].frames[0].frames[0] && frames[0].frames[0].frames[0].document.readyState === 'complete')") }
    s.execute_script('window.held = frames[0].frames[0]')
    s.execute_script("document.querySelector('iframe').src = '/x'")
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/x' }

    expect(s.evaluate_script('window.held.closed')).to be(true)
  end

  # …but not one under way below it: a frame navigation a timer runs unloads its tree in a loop step, entering V8 with no
  # call of the host's around it, and a host call its handlers reach failing within it ends none of that walk.
  it "ends no walk a failing call did not begin, the frames' unload going on" do
    beacons = []
    log = ->(n) { "<script>addEventListener('unload', () => navigator.sendBeacon('/log/#{n}'))</script>" }
    pages = {
      '/top' => '<iframe src="/a"></iframe>',
      '/a'   => %(<iframe src="/c1"></iframe><iframe src="/c2"></iframe>#{log.('a')}),
      '/c1'  => "#{log.('c1')}<script>addEventListener('unload', () => localStorage.setItem('fail-inside', '1'))</script>",
      '/c2'  => log.('c2')
    }
    app = lambda do |env|
      beacons << env['PATH_INFO'].delete_prefix('/log/') if env['REQUEST_METHOD'] == 'POST'
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{pages[env['PATH_INFO']] || env['PATH_INFO']}"]]
    end
    s = simulated_session(app)
    s.visit '/top'
    poll_until { s.evaluate_script("!!(frames[0] && frames[0].frames.length === 2 && frames[0].frames[1].document.readyState === 'complete')") }
    browser = s.driver.instance_variable_get(:@browser)
    runtime = browser.instance_variable_get(:@runtime)
    # (…a host call the storage write reaches making a call of its own that fails)
    browser.singleton_class.prepend(Module.new {
      define_method(:storage_changed) do |*args|
        runtime.call('__csimNoSuchFunction') rescue nil if args.inspect.include?('fail-inside')
        super(*args)
      end
    })
    s.execute_script("setTimeout(() => { document.querySelector('iframe').srcdoc = '<p>next</p>' }, 50)")
    poll_until { s.evaluate_script("document.querySelector('iframe').contentDocument.body.textContent") == 'next' && beacons.size == 3 }

    expect(beacons.sort).to eq(%w[a c1 c2])
  end

  # …nor does an event-loop step: a timer navigating a frame whose teardown handler runs away, terminated by the call
  # timeout, leaves no unload counter of that frame raised — its next navigation goes ahead.
  %w[beforeunload unload].each do |event|
    it "lets a frame navigate again after a loop step terminated in its #{event} handler" do
      stub_const('Capybara::Simulated::V8Runtime::CALL_TIMEOUT_MS', 1000)
      pages = {
        '/top' => '<iframe src="/f"></iframe>',
        '/f'   => "<script>addEventListener('#{event}', () => { if (!top.halt) for (;;) {} })</script>"
      }
      app = ->(env) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{pages[env['PATH_INFO']] || env['PATH_INFO']}"]] }
      s = simulated_session(app)
      s.visit '/top'
      poll_until { s.evaluate_script("!!(frames[0] && frames[0].location.pathname === '/f' && frames[0].document.readyState === 'complete')") }
      s.execute_script("window.f = document.querySelector('iframe'); setTimeout(() => { f.srcdoc = '<p>x</p>' }, 20)")
      expect {
        3.times { s.evaluate_script('1') }
      }.to raise_error(RustyRacer::ScriptTerminatedError)
      s.execute_script("top.halt = true; f.removeAttribute('srcdoc'); f.src = '/h'")
      poll_until { (s.evaluate_script('frames[0].location.pathname') rescue nil) == '/h' }

      expect(s.evaluate_script('frames[0].location.pathname')).to eq('/h')
    end
  end

  it 'ends a walk a failed call left open' do
    app = ->(env) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{env['PATH_INFO']}"]] }
    s = simulated_session(app)
    s.visit '/a'
    expect {
      s.execute_script("const walk = __dom.promptWalk(0, false); __dom.walkNext(walk); throw new Error('left open')")
    }.to raise_error(/left open/)
    s.execute_script("location.href = '/b'")
    poll_until { s.evaluate_script('location.pathname') == '/b' }

    expect(s).to have_current_path('/b')
  end
end
