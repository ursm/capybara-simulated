require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# A function one window's script hands another window of its browsing context group — an argument of a method it calls
# there, a value it sets there, a call's result — is that function itself: a pop-up's documents are realms of its
# opener's isolate. Called from the other window it runs in the realm that made it: what it throws is an exception of
# that realm, thrown to the caller; one that is a listener of the receiving window reports its exception in its own
# realm; calls that recurse from window to window overflow the one stack; and a function of a document navigated away
# still runs, in that document's realm (Chrome and Firefox measured).
RSpec.describe 'a function handed to another window of its group' do
  let(:pages) {
    {
      '/opener' => <<~JS,
        window.check = (v) => { if (!v) throw new Error('assert failed'); };
        window.typed = () => null.x;
        window.step = (f) => { try { f(); return 'ok'; } catch (e) { return 'caught ' + e.message; } };
        window.ping = (n) => (n <= 0 ? 0 : w.pong(n - 1) + 1);
        window.hit = (s) => 'A ' + s + ':' + typeof document;
      JS
      '/other'  => "window.other = (s) => { window.called = s; return 'B'; };",
      '/popup'  => <<~JS
        window.keep = null;
        window.store = (f) => { keep = f; };
        window.later = () => keep('late');
        window.pong = (n) => opener.ping(n);
      JS
    }
  }
  let(:app) {
    pages = self.pages
    lambda {|env|
      title = env['PATH_INFO'].delete_prefix('/')
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><title>#{title}</title><script>#{pages.fetch(env['PATH_INFO'], '')}</script>"]]
    }
  }
  let(:session) { simulated_session(app) }
  before do
    session.visit 'http://a.test/opener'
    session.execute_script("window.w = open('/popup', 'pw')")
  end

  def run(script) = session.execute_script(script)
  def read(expr) = session.evaluate_script(expr)
  def in_popup(&) = session.within_window(session.windows.last, &)

  it 'throws in the caller what the function threw, an exception of the realm that made it' do
    in_popup do
      expect(read("(() => { try { opener.check(false); return 'none'; } catch (e) { return [e.name, e.message, e instanceof opener.Error, e instanceof Error]; } })()"))
        .to eq(['Error', 'assert failed', true, false])
      expect(read("(() => { try { opener.typed(); } catch (e) { return [e.name, e instanceof opener.TypeError]; } })()")).to eq(['TypeError', true])
    end
  end

  it 'throws what a function the caller handed back threw, through the window it called' do
    in_popup do
      expect(read("[opener.step(() => opener.check(false)), opener.step(() => { throw new Error('own'); }), opener.step(() => {})]"))
        .to eq(['caught assert failed', 'caught own', 'ok'])
    end
  end

  it 'throws a RangeError for calls that recurse from window to window without end' do
    expect(read("(() => { try { return ping(1e6); } catch (e) { return e.name; } })()")).to eq('RangeError')
    expect(read('ping(240)')).to eq(240)
  end

  # (…HTML "report the exception": the callback's realm's — its `error` event the opener's, the pop-up's none)
  it "reports what a listener of its threw in the window's dispatch in its own realm" do
    run(<<~JS)
      window.errors = [];
      addEventListener('error', (e) => errors.push(e.message));
      w.addEventListener('message', () => { throw new Error('in listener'); });
      w.postMessage('go', '*');
    JS
    expect(read('window.errors')).to eq(['Error: in listener'])
  end

  # (…Chrome and Firefox measured: `keep('late')` of the page's first document, read again after it navigated, runs in
  # that document's realm)
  it 'runs a function of a document navigated away, in its realm' do
    run('w.store(window.hit)')
    expect(session.within_window(session.windows.last) { read('later()') }).to eq('A late:object')
    session.visit 'http://a.test/other'
    run("window.w = open('', 'pw')")
    expect(session.within_window(session.windows.last) { read('later()') }).to eq('A late:object')
    expect(read('[window.called, window.hit]')).to eq([nil, nil])
  end
end

# …and one handed a window of another isolate — a pop-up opened at a URL of another site, a Browser of its own
# (Driver#hosts_partition?), navigated back to its opener's origin, whose script reaches it through a WindowProxy of
# that isolate (platform-globals.js `csimWindowProxy`) — crosses as a callback handle: the receiving window holds a
# function that calls it back through the host, synchronously (platform-globals.js `__csimRemoteCallback`). What it
# throws is thrown again in the caller, an Error of its kind there; calls that recurse from window to window stop at
# `Driver::WINDOW_CALL_DEPTH_MAX`; a handle of a document gone calls nothing of the next (the gap CLAUDE.md lists); and
# those the receiver lets go of are let go of where they were made.
RSpec.describe "a function handed to another isolate's window" do
  let(:pages) {
    {
      '/opener' => <<~JS,
        window.check = (v) => { if (!v) throw new Error('assert failed'); };
        window.typed = () => null.x;
        window.ping = (n) => (n <= 0 ? 0 : w.pong(n - 1) + 1);
        window.hit = (s) => 'A ' + s;
      JS
      '/other'  => "window.other = (s) => { window.called = s; return 'B'; };",
      '/popup'  => <<~JS
        window.keep = null;
        window.store = (f) => { keep = f; };
        window.later = () => keep('late');
        window.pong = (n) => opener.ping(n);
        window.take = (f) => 1;
      JS
    }
  }
  let(:app) {
    pages = self.pages
    ->(env) { [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><script>#{pages.fetch(env['PATH_INFO'], '')}</script>"]] }
  }
  let(:session) { simulated_session(app) }
  before do
    session.visit 'http://a.test/opener'
    browsers = session.driver.window_browsers.size
    session.execute_script("window.w = open('http://other.test/x', 'pw')")
    expect(session.driver.window_browsers.size).to eq(browsers + 1)
    session.execute_script("w.location = 'http://a.test/popup'")
    expect(read('typeof w.take')).to eq('function')
  end

  def run(script) = session.execute_script(script)
  def read(expr) = session.evaluate_script(expr)
  def in_popup(&) = session.within_window(session.windows.last, &)

  it 'throws in the caller what the function threw, an Error of its kind' do
    in_popup do
      expect(read("(() => { try { opener.check(false); return 'none'; } catch (e) { return [e.name, e.message, e instanceof Error]; } })()"))
        .to eq(['Error', 'assert failed', true])
      expect(read("(() => { try { opener.typed(); } catch (e) { return [e.name, e instanceof TypeError]; } })()")).to eq(['TypeError', true])
    end
  end

  # (…a ping-pong 240 round trips deep, 480 calls nested, under `Driver::WINDOW_CALL_DEPTH_MAX`)
  it 'throws a RangeError for calls that recurse from window to window without end' do
    expect(read("(() => { try { return ping(1e6); } catch (e) { return e.name; } })()")).to eq('RangeError')
    expect(read('ping(240)')).to eq(240)
  end

  it 'calls nothing of the next document through a handle of a document gone' do
    run('w.store(window.hit)')
    expect(in_popup { read('later()') }).to eq('A late')
    session.visit 'http://a.test/other'
    run("window.w = open('', 'pw')")
    expect(in_popup { read('later()') }).to be_nil
    expect(read('window.called')).to be_nil
  end

  # (…3000 closures over 200 KB each: let go of here as the pop-up's isolate collects the functions it held them by)
  it 'lets go of the functions the receiver let go of' do
    ctx = session.driver.browser.instance_variable_get(:@runtime).instance_variable_get(:@ctx)
    used = -> { ctx.low_memory_notification; ctx.heap_statistics[:used_heap_size] >> 20 }
    before = used.()
    run('for (let i = 0; i < 3000; i++) { const big = new Array(25000).fill(i); w.take(() => big.length); }')
    expect(used.() - before).to be < 40
  end
end
