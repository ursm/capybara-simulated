require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# A window `window.open` opened at a URL is another Browser — another isolate — which its opener reaches through a
# WindowProxy of its own (platform-globals.js `csimWindowProxy`). HTML's: same origin, its Window and its Location are
# the real ones, whole; cross-origin, their CrossOriginProperties alone (HTML §7.2.1.3), anything else a SecurityError —
# asked as each member is reached, by the origin the window's traversable published for its active document.
RSpec.describe 'a WindowProxy of another isolate\'s window' do
  # (…a page's script by its path: /opens opens a pop-up when its `f` is called, whose boot — /moves — navigates it)
  let(:scripts) {
    {
      '/opens' => "window.f = () => { window.open('/moves'); return 'returned'; };",
      '/moves' => "opener.location.pathname = '/dir/moved';"
    }
  }
  let(:hits) { Hash.new(0) }
  let(:app) {
    hits, scripts = self.hits, self.scripts
    lambda do |env|
      hits[env['PATH_INFO']] += 1
      title  = env['PATH_INFO'].delete_prefix('/')
      script = scripts[env['PATH_INFO']]
      [200, {'content-type' => 'text/html'}, ["<!doctype html><title>#{title}</title><p>#{env['HTTP_HOST']}#{env['PATH_INFO']}</p><script>#{script}</script>"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/dir/page' }

  def open_window(url) = session.execute_script("window.w = window.open(#{url.to_json})")
  # What reading `expr` (of `w`) ends in: its value, or the name of what it threw.
  def read(expr) = session.evaluate_script("(() => { try { return #{expr}; } catch (e) { return e.name; } })()")

  context 'of its origin' do
    before { open_window('/pop?x=1#frag') }

    it "has its Location's every part" do
      expect(read('w.location.href')).to eq('http://a.test/pop?x=1#frag')
      expect(read('[w.location.protocol, w.location.host, w.location.hostname, w.location.port]')).to eq(['http:', 'a.test', 'a.test', ''])
      expect(read('[w.location.origin, w.location.pathname, w.location.search, w.location.hash]')).to eq(['http://a.test', '/pop', '?x=1', '#frag'])
      expect(read('String(w.location)')).to eq('http://a.test/pop?x=1#frag')
    end

    it 'reaches its document' do
      expect(read('w.document.title')).to eq('pop')
      expect(read('w.history.length')).to eq(1)
    end

    it 'reloads it' do
      session.execute_script('w.location.reload()')
      expect(hits['/pop']).to eq(2)
      expect(read('w.history.length')).to eq(1)
    end

    # (…`replace()` with history handling "replace", `assign()` without; both resolved against the opener's document, the
    # entry settings object's — /dir/next, not /next)
    it 'navigates it by replace() in place of its entry, and by assign() to a new one' do
      session.execute_script("w.location.replace('next')")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/dir/next', 1])
      session.execute_script("w.location.assign('again')")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/dir/again', 2])
    end

    it 'navigates it to a fragment of its document within that document' do
      session.execute_script("w.location.href = 'http://a.test/pop?x=1#other'")
      expect(read('[w.location.hash, w.history.length]')).to eq(['#other', 2])
      expect(hits['/pop']).to eq(1)
    end

    it 'throws a SyntaxError for a navigation to no URL' do
      expect(read("w.location.href = 'http://a.test:-1/'")).to eq('SyntaxError')
    end

    it "lists its Location's members, which JSON serializes" do
      expect(read('Object.keys(w.location).length')).to eq(14)
      expect(read('JSON.parse(JSON.stringify(w.location)).pathname')).to eq('/pop')
    end

    it "defines and deletes the window's own properties" do
      expect(read("(Object.defineProperty(w, 'answer', {value: 42, configurable: true}), w.answer)")).to eq(42)
      expect(read('[delete w.answer, typeof w.answer]')).to eq([true, 'undefined'])
    end

    it 'carries undefined as itself, both ways' do
      expect(read("(w.v = undefined, [typeof w.v, 'v' in w])")).to eq(['undefined', true])
      expect(read("(w.eval('window.argc = (...a) => a.length + \":\" + a.map(String)'), w.argc(undefined, undefined))")).to eq('2:undefined,undefined')
    end

    # (…Chrome and Firefox measured)
    it 'has this window its opener' do
      expect(read('w.opener === window')).to be(true)
    end

    # (…a script of its that calls into another window, and through it is navigated, navigated as that call returns —
    # not under it, which would rebuild its Context with its script on the stack)
    it 'is navigated by a window it opened as the call that opened it returns' do
      open_window('/opens')
      expect(read('w.f()')).to eq('returned')
      expect(read('w.location.pathname')).to eq('/dir/moved')
    end
  end

  context 'of another origin' do
    before { open_window('http://b.test/far') }

    it 'is a SecurityError for its document, its history and its own members' do
      expect(read('w.document')).to eq('SecurityError')
      expect(read('w.history')).to eq('SecurityError')
      expect(read('w.name')).to eq('SecurityError')
      expect(read("(w.name = 'x', 'set')")).to eq('SecurityError')
      expect(read('w.addEventListener')).to eq('SecurityError')
      expect(read('(w.onload = () => {}, "set")')).to eq('SecurityError')
      expect(read('w.__csimDocumentHtml')).to eq('SecurityError')
    end

    # (…[[HasProperty]] by [[GetOwnProperty]], HTML's: Chrome and Firefox measured)
    it 'is a SecurityError to ask for a member it does not expose, and true for one it does' do
      expect(read("'document' in w")).to eq('SecurityError')
      expect(read("'name' in w")).to eq('SecurityError')
      expect(read("['location' in w, 'then' in w]")).to eq([true, true])
      expect(read("'pathname' in w.location")).to eq('SecurityError')
      expect(read("'replace' in w.location")).to be(true)
    end

    it 'has this window its opener' do
      expect(read('w.opener === window')).to be(true)
    end

    it "is a SecurityError for its Location's every member but the href setter and replace()" do
      expect(read('w.location.href')).to eq('SecurityError')
      expect(read('w.location.pathname')).to eq('SecurityError')
      expect(read('w.location.reload')).to eq('SecurityError')
      expect(read('Object.keys(Object.getOwnPropertyDescriptors(w.location))')).to eq(['href', 'replace'])
    end

    it 'answers its CrossOriginProperties' do
      expect(read('[w.window === w, w.self === w, w.frames === w, w.top === w, w.parent === w]')).to eq([true] * 5)
      expect(read('[w.closed, typeof w.postMessage, typeof w.close, typeof w.focus, typeof w.blur]')).to eq([false, 'function', 'function', 'function', 'function'])
      expect(read('w.then')).to be_nil
      expect(read('Object.getOwnPropertyNames(w)')).to include('location', 'postMessage', 'opener', 'then')
      expect(read("typeof Object.getOwnPropertyDescriptor(w, 'location').set")).to eq('function')
      expect(read("Object.getOwnPropertyDescriptor(w, 'opener').set")).to be_nil
    end

    it 'navigates it by replace(), and by its location set — and reaches it again once it is of this origin' do
      session.execute_script("w.location.replace('http://b.test/near')")
      expect(hits['/near']).to eq(1)
      session.execute_script("w.location = '/back'")
      expect(read('[w.document.title, w.location.pathname, w.history.length]')).to eq(['back', '/back', 2])
    end
  end
end
