# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A top-level document's `javascript:` URL: a string result makes the document that replaces it (HTML "evaluate a javascript:
# URL", whose response is at the active document's URL, of its policy container and opener policy), in a new entry in place
# of its own, and any other result none. The page's, and a pop-up's of the opener's isolate, which commit apart. Chrome 157 and
# Firefox 159 measured, where they say otherwise noted (~/.local/share/csim-bench/js/jsu).
RSpec.describe 'a top-level javascript: URL' do
  include PollUntil

  # What the document records on its way out: a realm that goes takes its own variables with it.
  let(:target_document) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><title>target</title><body>T
      <script>
        window.expando = 1;
        for (const type of ['beforeunload', 'pagehide', 'unload']) addEventListener(type, () => sessionStorage.setItem('left', (sessionStorage.getItem('left') || '') + type + ' '));
      </script>
    HTML
  }

  let(:requests) { [] }
  let(:session) {
    log = requests
    simulated_session(lambda {|env|
      log << [env['REQUEST_METHOD'], env['PATH_INFO'], env['HTTP_REFERER']]
      headers = {'content-type' => 'text/html'}
      headers['referrer-policy'] = 'no-referrer' if env['PATH_INFO'] == '/no-referrer'
      headers.update('cross-origin-opener-policy' => 'same-origin', 'cross-origin-embedder-policy' => 'require-corp') if env['PATH_INFO'] == '/coop'
      [200, headers, [target_document]]
    })
  }
  let(:markup) { %q(javascript:'<!DOCTYPE html><title>J</title><body>J<a id=a href=/next>a</a>') }

  # Each of the two top-level documents, driven by what it evaluates and when it has the new document.
  shared_examples 'a document of a top-level navigable' do
    it 'makes the document at the URL it was at, its entry in place of the last, its Window a new one' do
      go('/target')
      run("history.replaceState({s: 1}, ''); window.name = 'kept'; location.href = #{markup.inspect}")
      expect(poll_until { read('document.title') == 'J' && read('document.readyState') == 'complete' }).to be(true)
      expect(read('location.href')).to eq('http://www.example.com/target')
      expect(read('document.body.textContent')).to eq('Ja')
      expect(read('history.length')).to eq(1)
      expect(read('typeof window.expando')).to eq('undefined')
      expect(read('window.name')).to eq('kept')
      expect(read('document.contentType')).to eq('text/html')
      expect(read('document.characterSet')).to eq('UTF-8')
      # (…of no request, so no referrer: HTML "initialize the Document object"; Chrome keeps the last)
      expect(read('document.referrer')).to eq('')
      # (…its entry a new one, its classic history API state none: Chrome keeps the last)
      expect(read('history.state')).to be_nil
      # (…the document it replaces unloaded, unasked: Chrome; Firefox asks)
      expect(read("sessionStorage.getItem('left')")).to eq('pagehide unload ')
      expect(requests.count {|_, path, _| path == '/target' }).to eq(1)
    end

    it 'makes none of a result that is no string, nor of a throw' do
      go('/target')
      run("location.href = 'javascript:void(window.ran = 1)'")
      expect(poll_until { read('window.ran') }).to eq(1)
      run("location.href = 'javascript:window.ran = 2; 3'")
      expect(poll_until { read('window.ran') == 2 }).to be(true)
      run("location.href = 'javascript:window.ran = 4; throw 1'")
      expect(poll_until { read('window.ran') == 4 }).to be(true)
      settle
      expect(read('document.title')).to eq('target')
      expect(read('window.expando')).to eq(1)
    end

    it 'gives way to a navigation its script planned, and to one begun after it' do
      go('/target')
      run(%q(location.href = "javascript:location.href = '/planned'; '<title>J</title>'"))
      expect(poll_until { read('location.pathname') == '/planned' }).to be(true)
      settle
      expect(read('document.title')).to eq('target')
      run("location.href = #{markup.inspect}; location.href = '/after'")
      expect(poll_until { read('location.pathname') == '/after' }).to be(true)
      settle
      expect(read('document.title')).to eq('target')
    end

    it 'ends the navigation under way, whose document it makes instead' do
      go('/target')
      run("location.href = '/planned'; location.href = #{markup.inspect}")
      expect(poll_until { read('document.title') == 'J' }).to be(true)
      expect(read('location.pathname')).to eq('/target')
      expect(requests.map {|_, path, _| path }).not_to include('/planned')
    end

    it "keeps its document's referrer policy, of its policy container" do
      go('/no-referrer')
      run("location.href = #{markup.inspect}")
      expect(poll_until { read('document.title') == 'J' }).to be(true)
      run("document.getElementById('a').click()")
      expect(poll_until { read('location.pathname') == '/next' }).to be(true)
      expect(requests.last).to eq(['GET', '/next', nil])
    end

    it 'reloads as a GET of its URL, the document no longer one of a request' do
      go('/target')
      run("location.href = #{markup.inspect}")
      expect(poll_until { read('document.title') == 'J' }).to be(true)
      run('location.reload()')
      expect(poll_until { read('document.title') == 'target' }).to be(true)
      expect(requests.count {|_, path, _| path == '/target' }).to eq(2)
    end
  end

  context 'in the page' do
    def go(path) = session.visit(path)
    def run(script) = session.execute_script(script)
    def read(expression) = session.evaluate_script(expression)
    def settle = session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')

    it_behaves_like 'a document of a top-level navigable'

    # (…its opener policy the active document's, HTML "evaluate a javascript: URL": no group left, the windows it opened
    # their opener still, and cross-origin isolated as it was. Chrome and Firefox: no switch.)
    it 'stays in its browsing context group, its opener policy kept', :every_host_local do
      session.visit('https://a.test/coop')
      expect(session.evaluate_script('crossOriginIsolated')).to be(true)
      popup = session.window_opened_by { session.execute_script("window.open('/coop')") }
      session.execute_script("location.href = #{markup.inspect}")
      expect(poll_until { session.evaluate_script('document.title') == 'J' }).to be(true)
      expect(session.evaluate_script('crossOriginIsolated')).to be(true)
      session.within_window(popup) { expect(session.evaluate_script('opener !== null')).to be(true) }
    end
  end

  # …by whichever realm's script navigates it, a frame's too (HTML: the task runs in the navigable's active document).
  it "makes the page's document of a URL its frame's script navigated the page to" do
    session.visit('/target')
    session.execute_script("const f = document.createElement('iframe'); f.src = '/framed'; document.body.append(f); window.f = f")
    expect(poll_until { session.evaluate_script("f.contentDocument?.title === 'target' && f.contentDocument.readyState === 'complete'") }).to be(true)
    session.execute_script("f.contentWindow.eval(#{"top.location.href = #{markup.inspect}".inspect})")
    expect(poll_until { session.evaluate_script('document.title') == 'J' }).to be(true)
    expect(session.evaluate_script('location.pathname')).to eq('/target')
  end

  # …and a reload begun beside it, whichever first, makes the document in the end: the reload's.
  it 'gives way to a reload begun beside it' do
    session.visit('/target')
    session.execute_script("location.reload(); location.href = #{markup.inspect}")
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(poll_until { requests.count {|_, path, _| path == '/target' } == 2 }).to be(true)
    expect(poll_until { session.evaluate_script('document.title') == 'target' }).to be(true)
  end

  context 'in a pop-up of its opener’s isolate' do
    def go(path)
      session.visit('/opener')
      session.execute_script("window.w = window.open(#{path.inspect})")
      expect(poll_until { read('location.pathname') == path && read('document.readyState') == 'complete' }).to be(true)
    end
    def run(script) = session.execute_script("w.eval(#{script.inspect})")
    def read(expression) = session.evaluate_script("w.eval(#{expression.inspect})")
    def settle = session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')

    it_behaves_like 'a document of a top-level navigable'

    # HTML "initialize the Document object": its initial about:blank of the origin of what it makes, its Window is the one it
    # had, though Chrome and Firefox make another.
    it 'keeps the Window of its initial about:blank, its URL and origin its own' do
      session.visit('/opener')
      session.execute_script(%q(window.w = window.open(); w.kept = 1; w.location.href = "javascript:'<title>J</title><body>J'"))
      expect(poll_until { session.evaluate_script('w.document.title') == 'J' }).to be(true)
      expect(session.evaluate_script('w.kept')).to eq(1)
      expect(session.evaluate_script('w.location.href')).to eq('about:blank')
      expect(session.evaluate_script('w.origin')).to eq('http://www.example.com')
      expect(session.evaluate_script('w.document.baseURI')).to eq('http://www.example.com/opener')
      expect(session.evaluate_script('w.history.length')).to eq(1)
    end

    it 'reads the same WindowProxy afterward, its opener its own' do
      go('/target')
      session.execute_script("window.held = w; w.location.href = #{markup.inspect}")
      expect(poll_until { session.evaluate_script('w.document.title') == 'J' }).to be(true)
      expect(session.evaluate_script('held === w && held.opener === window')).to be(true)
    end
  end

  # (…a POST made the document it replaces: its entry's resource none now, which a reload makes a GET: "resource: null";
  # Chrome re-POSTs, Firefox asks.)
  context 'made over a document a POST made' do
    let(:session) {
      log = requests
      simulated_session(lambda {|env|
        log << env['REQUEST_METHOD']
        body = env['PATH_INFO'] == '/form' ? '<!DOCTYPE html><form method=post action=/done></form>' : "<!DOCTYPE html><title>#{env['REQUEST_METHOD']}</title>"
        [200, {'content-type' => 'text/html'}, [body]]
      })
    }

    it 'reloads as a GET' do
      session.visit('/form')
      session.execute_script('document.forms[0].submit()')
      expect(poll_until { session.evaluate_script('document.title') == 'POST' }).to be(true)
      session.execute_script(%q(location.href = "javascript:'<title>J</title>'"))
      expect(poll_until { session.evaluate_script('document.title') == 'J' }).to be(true)
      session.execute_script('location.reload()')
      expect(poll_until { session.evaluate_script('document.title') == 'GET' }).to be(true)
    end
  end
end
