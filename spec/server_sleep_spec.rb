# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# The app's `sleep` on the driver's thread, in the middle of a request the driver made of it, as a server takes its time: the
# page's event loop runs on meanwhile (Driver::SleepHook), as a browser's does as a response is awaited. A navigation that begins
# then ends the one under way (HTML "navigate", "this will abort other ongoing navigations"), whose response makes no document;
# no document is made from inside the fetch; and no task runs under a script of the page's, whose run to completion holds.
# Chrome 157 and Firefox 159 where they agree (~/.local/share/csim-bench/rvjs/o1 k48, m40); step 20 of the text where not.
RSpec.describe 'a server that takes its time' do
  include PollUntil

  let(:requests) { [] }
  let(:session) {
    log = requests
    simulated_session(lambda {|env|
      log << env['PATH_INFO']
      sleep(0.3) if env['PATH_INFO'].start_with?('/slow')
      Fiber.new { sleep(0.3) }.resume if env['PATH_INFO'] == '/fiber'
      if env['PATH_INFO'] == '/streamed'
        next [200, {'content-type' => 'text/html'}, Enumerator.new {|y|
          sleep(0.3)
          y << '<!DOCTYPE html><title>/streamed</title>'
        }]
      end
      type = env['PATH_INFO'].match?(/\.m?js\z/) ? 'text/javascript' : 'text/html'
      body = type == 'text/html' ? "<!DOCTYPE html><meta charset=utf-8><title>#{env['PATH_INFO']}</title><script>sessionStorage.L = (sessionStorage.L || '') + '#{env['PATH_INFO']} ';</script><body>#{env['PATH_INFO']}" : ''
      [200, {'content-type' => type}, [body]]
    })
  }
  let(:string_document) { %q(javascript:'<title>J</title><script>sessionStorage.L += "J "</script><body>J') }

  shared_examples 'a top-level navigable' do
    it 'goes to a navigation a timer began as the response was awaited, not the one it ended' do
      go('/a')
      run("location = '/slow'; setTimeout(() => { location = '/other'; }, 30)")
      expect(poll_until { read('location.pathname') == '/other' }).to be(true)
      settle
      expect(read('document.title')).to eq('/other')
      expect(read('sessionStorage.L')).to end_with('/a /other ')
    end

    it "ends the navigation under way with a javascript: URL's, its document made and no other" do
      go('/a')
      run("location = '/slow'; setTimeout(() => { location = #{string_document.inspect}; }, 30)")
      expect(poll_until { read('document.title') == 'J' }).to be(true)
      settle
      expect(read('document.title')).to eq('J')
      expect(read('sessionStorage.L')).to end_with('/a J ')
      expect(read('location.pathname')).to eq('/a')
    end

    # (…"apply the reload history step" sets the ongoing navigation to "traversal": both browsers reload, staying.)
    it 'reloads where a timer asked for it as the response was awaited' do
      go('/a')
      run("sessionStorage.removeItem('L'); location = '/slow'; setTimeout(() => { location.reload(); }, 30)")
      expect(poll_until { read('sessionStorage.L').to_s.include?('/a') }).to be(true)
      settle
      expect(read('location.pathname')).to eq('/a')
      expect(read('sessionStorage.L')).not_to include('/slow')
    end

    it 'goes where a form a timer submitted goes, as the response was awaited' do
      go('/a')
      run("location = '/slow'; setTimeout(() => { const f = document.createElement('form'); f.action = '/form'; document.body.append(f); f.submit(); }, 30)")
      expect(poll_until { read('location.pathname') == '/form' }).to be(true)
      settle
      expect(read('location.pathname')).to eq('/form')
    end

    # (…a streaming body's, read after the app returned: both browsers `/other`, its own document.)
    it 'goes to a navigation a timer began as the body was read' do
      go('/a')
      run("location = '/streamed'; setTimeout(() => { location = '/other'; }, 30)")
      expect(poll_until { read('location.pathname') == '/other' }).to be(true)
      settle
      expect(read('document.title')).to eq('/other')
    end

    # (…a sleep in a fiber of the app's its own all the same.)
    it 'goes to a navigation a timer began as a fiber of the app slept' do
      go('/a')
      run("location = '/fiber'; setTimeout(() => { location = '/other'; }, 30)")
      expect(poll_until { read('location.pathname') == '/other' }).to be(true)
      settle
      expect(read('document.title')).to eq('/other')
    end

    it 'runs the page meanwhile, a timer due before the response' do
      go('/a')
      run("window.L = []; setTimeout(() => { sessionStorage.fired = '1'; }, 30); location = '/slow'")
      expect(poll_until { read('location.pathname') == '/slow' }).to be(true)
      expect(read('sessionStorage.fired')).to eq('1')
    end
  end

  context 'in the page' do
    def go(path) = session.visit(path)
    def run(script) = session.execute_script(script)
    def read(expression) = session.evaluate_script(expression)
    def settle = session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 400))')

    it_behaves_like 'a top-level navigable'

    it 'holds a script of the page to completion through a fetch it made' do
      session.visit('/a')
      session.execute_script(<<~JS)
        window.L = [];
        setTimeout(() => { L.push('t0'); }, 0);
        const s = document.createElement('script');
        s.src = '/slow.js';
        document.head.append(s);
        L.push('after');
      JS
      expect(poll_until { session.evaluate_script('L.length') == 2 }).to be(true)
      expect(session.evaluate_script('L')).to eq(%w[after t0])
    end
  end

  context 'in a pop-up of its opener’s isolate' do
    def go(path)
      session.visit('/opener')
      session.execute_script("window.w = window.open(#{path.inspect})")
      expect(poll_until { read('location.pathname') == path && read('document.readyState') == 'complete' }).to be(true)
    end
    def run(script) = session.execute_script("w.eval(#{script.inspect})")
    def read(expression) = session.evaluate_script("w.eval(#{expression.inspect})")
    def settle = session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 400))')

    it_behaves_like 'a top-level navigable'
  end

  # (…"list of scripts that will execute in order as soon as possible": a fetch that runs the event loop runs none after it inside it.)
  it 'runs dynamic scripts of async false in order through a module whose fetch takes its time' do
    session.visit('/a')
    session.execute_script(<<~JS)
      window.L = [];
      for (const [type, src] of [['module', '/slow1.mjs'], ['', '/order2.js'], ['module', '/order3.mjs'], ['', '/order4.js']]) {
        const s = document.createElement('script');
        s.type = type;
        s.src = src;
        s.async = false;
        s.onload = () => L.push(src);
        document.head.append(s);
      }
    JS
    expect(poll_until { session.evaluate_script('L.length') == 4 }).to be(true)
    expect(session.evaluate_script('L')).to eq(['/slow1.mjs', '/order2.js', '/order3.mjs', '/order4.js'])
  end

  # (…a session the fetch is none of: its time passes as any does, and what its timer planned is taken.)
  it "takes what another session's timer planned as this session's server slept" do
    other = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><title>#{env['PATH_INFO']}</title>"]] })
    other.visit('/start')
    other.execute_script("setTimeout(() => { location = '/moved'; }, 100)")
    session.visit('/slow-visit')
    expect(other.current_url).to end_with('/moved')
  end

  it 'still paces a test: its own sleep runs what comes due' do
    session.visit('/a')
    session.execute_script("setTimeout(() => { document.title = 'paced'; }, 100)")
    sleep(0.2)
    expect(session.evaluate_script('document.title')).to eq('paced')
  end
end

# …its entry made as its document is (HTML "finalize a cross-document navigation"): `history.length` read as the response is
# awaited the one before it — Chrome 157 and Firefox 159, measured 2026-11-08 (~/.local/share/csim-bench/nc/probe).
RSpec.describe 'a navigation whose server takes its time', :every_host_local do
  include PollUntil

  let(:session) {
    simulated_session(lambda {|env|
      sleep(0.3) if env['PATH_INFO'] == '/slow'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>#{env['PATH_INFO']}</title>"]]
    })
  }

  it 'adds its session history entry only as its document is made' do
    session.visit('http://a.test/a')
    session.execute_script("sessionStorage.n = ''; location = '/slow'; setTimeout(() => { sessionStorage.n = history.length + ' ' + location.pathname; }, 30)")
    expect(poll_until { session.evaluate_script('location.pathname') == '/slow' }).to be(true)
    expect(session.evaluate_script('sessionStorage.n')).to eq('1 /a')
    expect(session.evaluate_script('history.length')).to eq(2)
  end

  # (…a traversal's document made at its own entry, what the document it leaves pushed as it was awaited let go: HTML
  # queues that push's "finalize a same-document navigation" behind the traversal, where it returns, the navigable's active
  # entry no longer its)
  it 'makes a traversal its own entry, a push the left document made as it was awaited let go' do
    session.visit('http://a.test/a')
    session.visit('http://a.test/slow')
    session.go_back
    session.execute_script("setTimeout(() => history.pushState('p', '', '/p'), 30)")
    session.go_forward
    expect(session.evaluate_script('[location.pathname, history.length, history.state]')).to eq(['/slow', 2, nil])
    session.go_back
    expect(session.evaluate_script('[location.pathname, document.title]')).to eq(['/a', '/a'])
  end

  # (…and the driver's URL its document's at once: what the document it left moved through as the response was awaited
  # none of the intermediates a polling `current_url` walks)
  it "reports its document's URL, none the left document moved through as it was awaited" do
    session.visit('http://a.test/a')
    session.execute_script("location = '/slow'; setTimeout(() => history.pushState(null, '', '/p'), 30)")
    expect(poll_until { session.evaluate_script('location.pathname') == '/slow' }).to be(true)
    expect(session.current_url).to eq('http://a.test/slow')
  end
end
