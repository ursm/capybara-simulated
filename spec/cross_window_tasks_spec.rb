require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# What a window's script asks of a window of another isolate — a message it posts, a navigation of it, its close — is a
# task of THAT window's event loop (HTML), never run while the asking script is: the ask recorded in the engine
# (session_history.rs `Asked`), taken as the window steps — one not the active window as the active one's step takes it
# (Browser#take_window_tasks_in_background).
RSpec.describe 'a task one window asks of another' do
  let(:scripts) {
    {
      # (…a pop-up whose unload and messages are logged in the origin's localStorage, which its opener reads)
      '/logs'   => <<~JS,
        const log = (s) => localStorage.setItem('log', (localStorage.getItem('log') || '') + s + ';');
        addEventListener('pagehide', () => log('pagehide'));
        addEventListener('unload', () => log('unload'));
        addEventListener('message', (e) => { log('message:' + e.data + ':' + e.origin + ':' + (e.source === opener)); document.title = e.data; });
      JS
      '/closes' => 'window.closeSelf = () => { close(); return closed; };',
      # (…the opener of /closer, which /closer closes as it loads, and which reads its own opener as null after)
      '/opens-closer' => "window.addEventListener('load', () => { window.open('/closer'); });",
      '/closer' => "window.addEventListener('load', () => { opener.close(); localStorage.setItem('closedAtOnce', String(opener.closed)); });"
    }
  }
  let(:hits) { Hash.new(0) }
  let(:app) {
    hits, scripts = self.hits, self.scripts
    lambda do |env|
      hits[env['PATH_INFO']] += 1
      title  = env['PATH_INFO'].delete_prefix('/')
      script = scripts[env['PATH_INFO']]
      [200, {'content-type' => 'text/html'}, ["<!doctype html><title>#{title}</title><script>#{script}</script>"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/page' }

  def open_window(url) = session.execute_script("window.w = window.open(#{url.to_json})")
  def read(expr) = session.evaluate_script(expr)

  it "closes a window as a task of its own: `closed` at once, its document unloaded after the caller's task" do
    open_window('/logs')
    expect(session.windows.size).to eq(2)
    # (…the unload not yet, as the closing script runs on: it is the window's task, after this one)
    expect(read("(() => { w.close(); const c = w.closed; localStorage.setItem('log', (localStorage.getItem('log') || '') + 'closed:' + c + ';'); return c; })()")).to be(true)
    expect(read("localStorage.getItem('log')")).to eq('closed:true;pagehide;unload;')
    expect(read('w.closed')).to be(true)
    expect(session.windows.size).to eq(1)
  end

  # (…a navigation planned of it before, or asked after, none it begins: the close destroys it first; nor a message
  # posted after, a task queued after the close's)
  it 'begins no navigation of a closing window, nor delivers a message posted after its close' do
    open_window('/logs')
    session.execute_script("w.location = '/before'; w.close(); w.location = '/after'; w.postMessage('late', '*');")
    expect(session.windows.size).to eq(1)
    expect([hits['/before'], hits['/after']]).to eq([0, 0])
    expect(read("localStorage.getItem('log')")).to eq('pagehide;unload;')
  end

  it 'closes a pop-up opened at a URL by its own `close()`' do
    open_window('/closes')
    popup = session.windows.last
    session.switch_to_window(popup)
    expect(read('closeSelf()')).to be(true)
    session.switch_to_window(session.windows.first)
    expect(session.windows.size).to eq(1)
    expect(read('w.closed')).to be(true)
  end

  it 'leaves a window the driver opened, navigated, to its own `close()`' do
    window = session.open_new_window
    session.switch_to_window(window)
    session.visit('http://a.test/closes')
    session.visit('http://a.test/closes?again')
    expect(read('closeSelf()')).to be(false)
    session.switch_to_window(session.windows.first)
    expect(session.windows.size).to eq(2)
  end

  # WPT html/browsers/windows/auxiliary-browsing-contexts/opener-closed.html: a pop-up closing its opener — itself a
  # pop-up, whose load opened it — as that one's load runs; the opener discarded after, its `opener` null to the pop-up.
  # (…every window stepped, as the WPT runner steps them: the pop-up's own load a task of its opener's, the second's its)
  it 'closes a pop-up whose load is still running, by the pop-up that load opened' do
    open_window('/opens-closer')
    20.times { session.driver.run_event_loop_frame(16) }
    expect(session.windows.size).to eq(2)
    expect(read("localStorage.getItem('closedAtOnce')")).to eq('true')
    closer = session.windows.last
    session.switch_to_window(closer)
    expect(read('opener')).to be_nil
  end

  it "delivers a message to a window that is not the active one, as the sender's task ends" do
    open_window('/logs')
    session.execute_script("w.postMessage('hi', '*'); window.titleAfterPost = w.document.title;")
    expect(read('window.titleAfterPost')).to eq('logs')
    expect(read('w.document.title')).to eq('hi')
    expect(read("localStorage.getItem('log')")).to eq('message:hi:http://a.test:true;')
  end

  # (…the navigation the window begins as a task of its own: the asking script still sees the document it had)
  it "navigates a window after the caller's task, resolved against the caller's document" do
    session.visit 'http://a.test/dir/page'
    open_window('/logs')
    expect(read("(() => { w.location = 'next'; return w.document.title; })()")).to eq('logs')
    expect(read('[w.location.pathname, w.document.title]')).to eq(['/dir/next', 'dir/next'])
  end
end
