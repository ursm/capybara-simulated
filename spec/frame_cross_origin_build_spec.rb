require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame's document is built as its container's document parses, whatever origin either is (HTML "process the iframe
# attributes" navigates it then). A cross-origin frame used to wait for its window to be read, so its scripts never ran
# with the page, and a frame of the page's origin inside it was then built on an initial about:blank of the cross-origin
# frame's origin: its first read was a SecurityError.
# Measured 2026-11-26 (Chrome 157, Firefox 159; top on 127.0.0.1, child on localhost, grandchild on 127.0.0.1): both
# request the child and the grandchild as the page loads; Chrome reports `child-ran,grand-ran,grand-load,top-load` and
# reads the grandchild's title on the first access.
RSpec.describe 'a cross-origin frame and its frames' do
  let(:requests) { [] }
  let(:app) {
    log = requests
    lambda do |env|
      log << "#{env['SERVER_NAME']}#{env['PATH_INFO']}"
      body = case env['PATH_INFO']
             when '/'
               <<~HTML
                 <!doctype html><meta charset=utf-8><title>top</title>
                 <script>var msgs = []; addEventListener('message', (e) => msgs.push(e.data + '@' + e.origin));</script>
                 <iframe src="http://cross.example.org/child"></iframe>
               HTML
             when '/child'
               <<~HTML
                 <!doctype html><meta charset=utf-8><title>child</title>
                 <script>parent.postMessage('child-ran', '*');</script>
                 <iframe src="http://www.example.com/grand"></iframe>
               HTML
             when '/grand'
               <<~HTML
                 <!doctype html><meta charset=utf-8><title>grand</title>
                 <script>top.postMessage('grand-ran', '*');</script>
               HTML
             end
      [200, {'content-type' => 'text/html'}, [body.to_s]]
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit 'http://www.example.com/' }

  it 'loads with the page, its scripts and its frames’ run' do
    expect(requests).to eq(['www.example.com/', 'cross.example.org/child', 'www.example.com/grand'])
    expect(session.evaluate_script('msgs')).to eq(['child-ran@http://cross.example.org', 'grand-ran@http://www.example.com'])
  end

  it 'reads a frame of the page’s origin inside it on the first access' do
    expect(session.evaluate_script(<<~JS)).to eq('grand http://www.example.com')
      (function () {
        try { return window[0][0].document.title + ' ' + window[0][0].origin; } catch (e) { return e.name; }
      })()
    JS
  end
end
