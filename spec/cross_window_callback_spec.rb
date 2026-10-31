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

# …and one handed a pop-up of another site, navigated back to its opener's origin — a realm of its opener's isolate too
# (Driver#open_aux_window), whose functions are its own: the function itself, called in the realm that made it.
RSpec.describe 'a function handed to a pop-up of another site' do
  let(:pages) {
    {
      '/opener' => <<~JS,
        window.check = (v) => { if (!v) throw new Error('assert failed'); };
        window.ping = (n) => (n <= 0 ? 0 : w.pong(n - 1) + 1);
        window.hit = (s) => 'A ' + s + ':' + typeof document;
      JS
      '/other'  => "window.other = (s) => { window.called = s; return 'B'; };",
      '/popup'  => <<~JS
        window.keep = null;
        window.store = (f) => { keep = f; };
        window.later = () => keep('late');
        window.pong = (n) => opener.ping(n);
        window.echo = (f) => f;
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
    session.execute_script("window.w = open('http://other.test/x', 'pw')")
    session.execute_script("w.location = 'http://a.test/popup'")
    expect(read('typeof w.echo')).to eq('function')
    expect(session.driver.window_browsers.size).to eq(1)
  end

  def run(script) = session.execute_script(script)
  def read(expr) = session.evaluate_script(expr)
  def in_popup(&) = session.within_window(session.windows.last, &)

  it 'is the function itself, which throws an exception of the realm that made it' do
    expect(read('w.echo(hit) === hit')).to be(true)
    in_popup do
      expect(read("(() => { try { opener.check(false); return 'none'; } catch (e) { return [e.message, e instanceof opener.Error, e instanceof Error]; } })()"))
        .to eq(['assert failed', true, false])
    end
  end

  it 'throws a RangeError for calls that recurse from window to window without end' do
    expect(read("(() => { try { return ping(1e6); } catch (e) { return e.name; } })()")).to eq('RangeError')
  end

  # (…Chrome and Firefox measured, as above: a function of a document navigated away still runs)
  it 'runs a function of a document navigated away, in its realm' do
    run('w.store(window.hit)')
    expect(in_popup { read('later()') }).to eq('A late:object')
    session.visit 'http://a.test/other'
    run("window.w = open('', 'pw')")
    expect(in_popup { read('later()') }).to eq('A late:object')
    expect(read('window.called')).to be_nil
  end
end
