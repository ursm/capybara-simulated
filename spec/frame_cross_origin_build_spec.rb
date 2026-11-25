require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/every_host_local'

# A frame's document is built as its container's document parses, whatever origin either is (HTML "process the iframe
# attributes" navigates it then). A cross-origin frame used to wait for its window to be read, so its scripts never ran
# with the page, and a frame of the page's origin inside it was then built on an initial about:blank of the cross-origin
# frame's origin: its first read was a SecurityError.
# Measured 2026-11-26 (Chrome 157, Firefox 159; top on 127.0.0.1, child on localhost, grandchild on 127.0.0.1): both
# request the child and the grandchild as the page loads; Chrome reports `child-ran,grand-ran,grand-load,top-load` and
# reads the grandchild's title on the first access.
Capybara.register_driver(:simulated_external_frames) {|app| Capybara::Simulated::Driver.new(app, external_frames: true) }

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
                 <iframe src="http://cross.test/child" onload="msgs.push('fload')"></iframe>
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

  # (…where the app serves the other host too)
  context 'of a host the app serves', :every_host_local do
    let(:session) { simulated_session(app) }

    before { session.visit 'http://www.example.com/' }

    it 'loads with the page, its scripts and its frames’ run' do
      expect(requests).to eq(['www.example.com/', 'cross.test/child', 'www.example.com/grand'])
      expect(session.evaluate_script('msgs')).to eq(['child-ran@http://cross.test', 'grand-ran@http://www.example.com', 'fload'])
    end

    it 'reads a frame of the page’s origin inside it on the first access' do
      expect(session.evaluate_script(<<~JS)).to eq('grand http://www.example.com')
        (function () {
          try { return window[0][0].document.title + ' ' + window[0][0].origin; } catch (e) { return e.name; }
        })()
      JS
    end
  end

  # A frame of a host the app does not serve goes to no network by default (Browser#navigation_network_hop): a network
  # error, its error document of no origin the page shares, its container's `load` fired — HTML, and Chrome 157
  # (measured 2026-11-26: `load`, `contentDocument` null, its `location` a SecurityError; Firefox 159 fires no `load`).
  context 'of a host the app does not serve' do
    let(:session) { simulated_session(app) }

    before { session.visit 'http://www.example.com/' }

    it 'is a network error, its container loaded, nothing requested' do
      expect(session.evaluate_script('msgs')).to eq(['fload'])
      expect(requests).to eq(['www.example.com/'])
      expect(session.evaluate_script(<<~JS)).to eq('null SecurityError')
        (function () {
          const f = document.querySelector('iframe');
          let h;
          try { h = f.contentWindow.location.href; } catch (e) { h = e.name; }
          return String(f.contentDocument) + ' ' + h;
        })()
      JS
    end
  end

  # …or to the network where the session allows it (`external_frames: true`): here refused there, so the app is asked, as
  # for any other request of another host.
  context 'with external frames allowed' do
    let(:session) { simulated_session(app, mode: :simulated_external_frames) }

    it 'fetches it from the network' do
      fetched = []
      allow_any_instance_of(Capybara::Simulated::Browser).to receive(:net_http_fetch) {|_, url, *| fetched << url.to_s; nil }
      session.visit 'http://www.example.com/'
      expect(fetched).to include('http://cross.test/child')
      expect(session.evaluate_script('msgs')).to include('child-ran@http://cross.test', 'fload')
    end
  end
end
