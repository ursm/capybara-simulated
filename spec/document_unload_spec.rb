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
