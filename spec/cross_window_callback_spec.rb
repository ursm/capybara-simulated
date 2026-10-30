require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# A function one window's script hands a window of another isolate — an argument of a method it calls there, a value it
# sets there, a call's result — crosses as a callback handle: the receiving window holds a function that calls it back
# through the host, synchronously (platform-globals.js `__csimRemoteCallback`). What it throws is thrown again in the
# caller; one that is a listener of the receiving window's reports its exception in its own realm; a handle of a
# document gone calls nothing of the next; and those the receiver lets go of are let go of where they were made.
RSpec.describe 'a function handed to another isolate\'s window' do
  let(:pages) {
    {
      '/opener' => <<~JS,
        window.check = (v) => { if (!v) throw new Error('assert failed'); };
        window.typed = () => null.x;
        window.step = (f) => { try { f(); return 'ok'; } catch (e) { return 'caught ' + e.message; } };
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
    session.execute_script("window.w = open('/popup', 'pw')")
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

  it 'throws what a function the caller handed back threw, through the window it called' do
    in_popup do
      expect(read("[opener.step(() => opener.check(false)), opener.step(() => { throw new Error('own'); }), opener.step(() => {})]"))
        .to eq(['caught assert failed', 'caught own', 'ok'])
    end
  end

  it 'throws a RangeError for calls that recurse from window to window without end' do
    expect(read("(() => { try { return ping(1e6); } catch (e) { return e.name; } })()")).to eq('RangeError')
    expect(read('ping(3)')).to eq(3)
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

  it 'calls nothing of the next document through a handle of a document gone' do
    run('w.store(window.hit)')
    expect(session.within_window(session.windows.last) { read('later()') }).to eq('A late')
    session.visit 'http://a.test/other'
    run("window.w = open('', 'pw')")
    expect(session.within_window(session.windows.last) { read('later()') }).to be_nil
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
