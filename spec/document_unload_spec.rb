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
end
