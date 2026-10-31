require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# A window `window.open` opened at a URL — a realm of its opener's isolate — loads as a window does: made at its initial
# about:blank, which fires no load, then navigated as a task of its own once its opener's script is done, its document
# parsed, its scripts run and its DOMContentLoaded and `load` fired there (HTML "window open steps", "the end"). A
# listener its opener puts on it right after `open()` is on the Window its same-origin document keeps (HTML's window
# reuse), called in that load's dispatch, `this` the opener's WindowProxy of it. Chrome 156 and Firefox 159, measured
# 2026-10-31, every one.
RSpec.describe 'the load of a pop-up' do
  let(:scripts) {
    {
      # (…a pop-up that logs what its document does, in its origin's localStorage, which its opener reads)
      '/logs'       => <<~JS,
        const log = (s) => localStorage.setItem('log', (localStorage.getItem('log') || '') + s + ';');
        log('script:' + document.readyState);
        document.addEventListener('DOMContentLoaded', () => log('DOMContentLoaded'));
        addEventListener('load', (e) => log('load:' + (e.target === document)));
      JS
      # (…one reading what its opener gave its Window, as its script runs and as it loads)
      '/reads'      => "window.seen = [window.foo]; addEventListener('load', () => { seen.push(window.foo); opener.seen = seen.join(); });",
      # (…one whose load handler reads a flag the opener's listener for that load sets)
      '/flags'      => "addEventListener('load', () => { opener.heard.push('popup:' + opener.flag); });",
      '/closes'     => 'onload = () => close();',
      '/own-onload' => "window.onload = () => opener.heard.push('popup onload');",
      '/posts'      => <<~JS,
        opener.postMessage('during-script', '*');
        document.addEventListener('DOMContentLoaded', () => opener.postMessage('dcl', '*'));
        addEventListener('load', () => opener.postMessage('in-load', '*'));
      JS
      # (…one whose image a slow server holds its load for)
      '/slow'       => ''
    }
  }
  let(:hits) { Hash.new(0) }
  let(:app) {
    hits, scripts = self.hits, self.scripts
    lambda do |env|
      hits[env['PATH_INFO']] += 1
      next [204, {}, []] if env['PATH_INFO'] == '/204'
      if env['PATH_INFO'] == '/slowimg'
        sleep 0.4
        next [200, {'content-type' => 'image/gif'}, ['GIF89a']]
      end

      title  = env['PATH_INFO'].delete_prefix('/')
      script = scripts[env['PATH_INFO']]
      body   = <<~HTML
        <button onclick="window.w = window.open('/logs')">open</button><a id="blank" href="/logs" target="_blank">blank</a>
        <button onclick="window.w = window.open('/logs'); setTimeout(() => { w.onload = () => { window.heard = 'later'; }; }, 0)">open later</button>
      HTML
      body = '<img src="/slowimg">' if env['PATH_INFO'] == '/slow'
      [200, {'content-type' => 'text/html'}, ["<!doctype html><title>#{title}</title><script>#{script}</script>#{body}"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/page' }

  def run(script) = session.execute_script(script)
  def read(expr) = session.evaluate_script("(() => { try { return #{expr}; } catch (e) { return e.name; } })()")
  def log = read("localStorage.getItem('log')")
  # (…the opener's own record of what its listeners heard)
  def heard = read('window.heard')

  it "parses, runs and loads its document as tasks of its own, after its opener's script — DOMContentLoaded, then load" do
    run(<<~JS)
      window.w = open('/logs');
      window.atOpen = [w.document.URL, w.document.readyState];
      localStorage.setItem('log', 'opener;');
    JS
    expect(read('window.atOpen')).to eq(['about:blank', 'complete'])
    expect(log).to eq('opener;script:loading;DOMContentLoaded;load:true;')
    expect(read('[w.document.URL, w.document.readyState]')).to eq(['http://a.test/logs', 'complete'])
  end

  it 'fires the listeners its opener put on it as `open()` returned at the load of the document of its origin it opened' do
    run(<<~JS)
      window.heard = [];
      window.w = open('/logs');
      w.onload = function (e) { heard.push(['onload', this === w, e.target.URL, e.isTrusted]); };
      w.addEventListener('load', (e) => heard.push(['listener', e.currentTarget === w]));
    JS
    expect(heard).to eq([['onload', true, 'http://a.test/logs', true], ['listener', true]])
    expect(log).to eq('script:loading;DOMContentLoaded;load:true;')
  end

  it "keeps what its opener set on it as `open()` returned, the Window its document's — read as that one's script runs" do
    run("window.w = open('/reads'); w.foo = 42;")
    expect(read('[window.seen, w.foo]')).to eq(['42,42', 42])
  end

  # (…one opened at about:blank, or at none, its initial about:blank still — HTML's window open steps run the URL and
  # history update steps alone — whose Window "create and initialize a Document object" reuses: the spec's explicit rule,
  # where Chrome and Firefox keep nothing, measured 2026-10-31)
  it 'keeps what its opener set on a window it opened at about:blank, or at no URL, through the navigation after' do
    run("window.w = open('about:blank'); w.foo = 42; w.location = '/reads';")
    expect(read('[window.seen, w.foo]')).to eq(['42,42', 42])
    run("window.w = open(); w.foo = 43; w.location = '/reads';")
    expect(read('[window.seen, w.foo]')).to eq(['43,43', 43])
  end

  # (…its initial about:blank unloaded all the same, never shown: its `unload` alone, as the Window the next document
  # keeps hears — HTML "unload a document" fires `pagehide` and hides the document only where its page is showing, which
  # only "the end" of a parse (or a reactivation) makes it; Chrome and Firefox fire all three, measured 2026-10-31 — the
  # next document visible)
  it 'fires the unload alone of the initial about:blank whose Window the next document keeps, which is visible' do
    run(<<~JS)
      window.heard = [];
      window.w = open('/reads');
      for (const type of ['pagehide', 'visibilitychange', 'unload']) w.addEventListener(type, () => heard.push(type));
    JS
    probe = '[window.seen, heard, w.document.visibilityState, w.document.hidden]'
    expect(read(probe)).to eq([',', %w[unload], 'visible', false])
  end

  # (…as a browser's one event loop does: the opener's listener, put on the Window first, runs first, in the load's own
  # dispatch — the pop-up still open, its messages tasks after)
  it "calls its opener's listeners in the dispatch of its load, in the order they were added" do
    run(<<~JS)
      window.heard = [];
      window.flag = 0;
      window.w = open('/flags');
      w.addEventListener('load', () => { heard.push('opener'); window.flag = 1; });
    JS
    expect(read('window.heard')).to eq(['opener', 'popup:1'])
  end

  it "calls its opener's listener while it is open, though its own handler closes it" do
    run("window.heard = []; window.w = open('/closes'); w.addEventListener('load', () => heard.push(w.closed));")
    expect(read('[window.heard, w.closed]')).to eq([[false], true])
  end

  it "calls none of its opener's `onload` its own document's replaced, the one event handler" do
    run("window.heard = []; window.w = open('/own-onload'); w.onload = () => heard.push('opener onload');")
    expect(read('window.heard')).to eq(['popup onload'])
  end

  # (…its load a task of the one event loop after the messages its parse posted, its opener's listener of it called in its
  # dispatch, before the message its load handler posts: Firefox 159 measured 2026-10-31 — Chrome 156 fires the load
  # first; HTML orders tasks of two task sources as a UA likes, and WPT replace-before-load/form-submit-popup.html asserts
  # Firefox's)
  it 'delivers the messages it posted as it parsed before its load, which its opener hears in that load' do
    run(<<~JS)
      window.heard = [];
      addEventListener('message', (e) => heard.push(e.data));
      window.w = open('/posts');
      w.addEventListener('load', () => heard.push('opener listener'));
    JS
    expect(read('window.heard')).to eq(['during-script', 'dcl', 'opener listener', 'in-load'])
  end

  # (…its load held for an image the server is slow to send, fired as the opener's wait polls, the pop-up not the active
  # window)
  it 'fires its load once an image held it, as a wait polls its opener' do
    run("window.w = open('/slow'); w.onload = () => document.body.insertAdjacentHTML('beforeend', '<p id=loaded>loaded</p>');")
    expect(session).to have_css('#loaded', wait: 3)
  end

  it 'fires none at the load of a document a later navigation makes, its Window another' do
    run("window.heard = []; window.w = open('/logs');")
    run("w.onload = () => heard.push('old'); w.addEventListener('load', () => heard.push('old listener')); w.location = '/logs?2';")
    expect(read('w.location.search')).to eq('?2')
    expect(heard).to eq([])
    expect(read('w.onload')).to be_nil
  end

  it 'fires none at the load of a document of another origin, whose Window is not its initial one' do
    run(<<~JS)
      window.heard = [];
      window.w = open('http://b.test/logs');
      w.onload = () => heard.push('onload');
      w.addEventListener('load', () => heard.push('listener'));
    JS
    expect(read('w.onload')).to eq('SecurityError')
    expect(heard).to eq([])
    expect(hits['/logs']).to eq(1)
  end

  # (…`open('about:blank')`: the initial about:blank at that URL, no navigation, no load)
  it 'fires no load at its initial about:blank — nor at the about:blank it was opened at' do
    run("window.heard = []; window.w = open('about:blank'); w.addEventListener('load', () => heard.push('load'));")
    expect(read('[w.document.URL, w.document.readyState]')).to eq(['about:blank', 'complete'])
    expect(heard).to eq([])
  end

  context 'navigated to a response of no content' do
    it 'fires no load at the window it opened at one, left at its initial about:blank' do
      run("window.heard = []; window.w = open('/204'); w.onload = () => heard.push('onload');")
      expect(hits['/204']).to eq(1)
      expect(read('[w.document.URL, w.document.readyState]')).to eq(['about:blank', 'complete'])
      expect(heard).to eq([])
    end

    it 'fires none at a window whose document it leaves in place' do
      run("window.w = open('/logs');")
      run("localStorage.setItem('log', ''); w.location = '/204';")
      expect(hits['/204']).to eq(1)
      expect(read('w.location.pathname')).to eq('/logs')
      expect(log).to eq('')
    end
  end

  it "reloads it as a task of its own, after the caller's script — its document the same until then" do
    run("window.w = open('/logs');")
    run("w.document.title = 'marked'; w.location.reload(); window.titleAfterReload = w.document.title; localStorage.setItem('log', '');")
    expect(read('window.titleAfterReload')).to eq('marked')
    expect(hits['/logs']).to eq(2)
    expect(read('w.document.title')).to eq('logs')
    expect(log).to eq('script:loading;DOMContentLoaded;load:true;')
  end

  it 'reloads nothing of a window still at its initial about:blank, the navigation it was opened for going on' do
    run("localStorage.setItem('log', ''); window.w = open('/logs'); w.location.reload();")
    expect(read('w.location.pathname')).to eq('/logs')
    expect(hits['/logs']).to eq(1)
    expect(log).to eq('script:loading;DOMContentLoaded;load:true;')
  end

  context 'opened by an action of the test' do
    it 'is at its document as `window_opened_by` returns it, a script\'s `window.open` the action ran' do
      window = session.window_opened_by { session.click_button 'open' }
      session.within_window(window) do
        expect(session).to have_current_path('http://a.test/logs', url: true)
        expect(session.title).to eq('logs')
      end
      expect(log).to eq('script:loading;DOMContentLoaded;load:true;')
    end

    # (…the opener's tasks already due run first: a browser's network fetch of the document outlasts them)
    it "fires an `onload` the action's handler set a task after its `open()`" do
      session.window_opened_by { session.click_button 'open later' }
      expect(read('window.heard')).to eq('later')
    end

    it "is at its document as `window_opened_by` returns it, a link's `_blank` target's" do
      window = session.window_opened_by { session.click_link 'blank' }
      session.within_window(window) { expect(session.title).to eq('logs') }
    end
  end
end
