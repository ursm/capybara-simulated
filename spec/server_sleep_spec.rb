# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

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
      type = env['PATH_INFO'].end_with?('.js') ? 'text/javascript' : 'text/html'
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

  it 'still paces a test: its own sleep runs what comes due' do
    session.visit('/a')
    session.execute_script("setTimeout(() => { document.title = 'paced'; }, 100)")
    sleep(0.2)
    expect(session.evaluate_script('document.title')).to eq('paced')
  end
end
