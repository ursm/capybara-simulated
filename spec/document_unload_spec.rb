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
end
