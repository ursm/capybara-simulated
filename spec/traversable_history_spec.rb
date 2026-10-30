require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'

# Each top-level traversable has a session history of its own (session_history.rs): the page's, a pop-up's in another
# isolate, a window `window.open` made in the opener's isolate. What another window's script asks of it — a traversal of
# that history, a navigation of it to a POST resource or to a `javascript:` URL — is a task of its own event loop (HTML
# "traverse the history by a delta", "navigate": the steps after the source snapshot continue in the target's agent),
# never run while the asking script is.
RSpec.describe 'the session history of each traversable' do
  let(:requests) { [] }
  let(:app) {
    requests = self.requests
    lambda do |env|
      body = env['rack.input']&.read.to_s
      # (…/gone a document once, then none: a 204's)
      next [204, {}, []] if env['PATH_INFO'] == '/gone' && requests.any? {|r| r[1] == '/gone' }

      requests << [env['REQUEST_METHOD'], env['PATH_INFO'], body, env['HTTP_ORIGIN']]
      title = env['PATH_INFO'].delete_prefix('/')
      frame = '<iframe src=/inner></iframe>' if env['PATH_INFO'] == '/framed'
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><title>#{title}</title><p>#{env['REQUEST_METHOD']} #{body}</p>#{frame}"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/page' }

  def read(expr) = session.evaluate_script(expr)
  def hits(path) = requests.count {|r| r[1] == path }

  context 'of a pop-up of another isolate' do
    before do
      session.execute_script("window.w = window.open('/a')")
      session.execute_script("w.location = '/b'")
      session.execute_script("w.location = '/c'")
    end

    it 'is traversed by its opener as a task of its own, after the script that asked' do
      expect(read("(() => { w.history.back(); return w.location.pathname; })()")).to eq('/c')
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/b', 3])
      expect(hits('/b')).to eq(2)
      session.execute_script('w.history.forward()')
      expect(read('w.location.pathname')).to eq('/c')
    end

    # (…the first of those asked of a document that one of them replaces: Chrome and Firefox, measured 2026-10-31; WPT
    # traverse_the_history_1-5 — the page's own likewise)
    it "applies the first of its opener's traversals asked in one task, which replaces its document" do
      expect(read('(() => { w.history.go(-2); const at = w.location.pathname; w.history.forward(); return at; })()')).to eq('/c')
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/a', 3])
      expect([hits('/a'), hits('/b')]).to eq([2, 1])
    end

    # (…HTML "apply the history step" sets the ongoing navigation to "traversal": Chrome and Firefox commit neither, though
    # each may request one first — measured 2026-10-31: Chrome /x, Firefox /y — whose fetch the traversal aborts; this
    # driver begins neither, which the request counts pin)
    it 'begins no navigation its opener planned with a traversal' do
      session.execute_script("w.location = '/x'; w.history.back()")
      session.execute_script("w.history.back(); w.location = '/y'")
      expect(read('w.location.pathname')).to eq('/a')
      expect([hits('/x'), hits('/y')]).to eq([0, 0])
    end

    it "reloads it for its opener's `go(0)`" do
      session.execute_script('w.history.go(0)')
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/c', 3])
      expect(hits('/c')).to eq(2)
    end

    # (…a reload a navigation, the later of the two aborting the earlier: HTML "set the ongoing navigation")
    it "lets the later of a navigation its opener planned and its `go(0)` win" do
      session.execute_script("w.location = '/x'; w.history.go(0)")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/c', 3])
      expect([hits('/x'), hits('/c')]).to eq([0, 2])
      session.execute_script("w.history.go(0); w.location = '/y'")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/y', 4])
    end

    it 'is a SecurityError to traverse by a History read before the window went to another origin' do
      session.execute_script("window.h = w.history; w.location = 'http://b.test/far'")
      expect(read('(() => { try { h.back(); return null; } catch (e) { return e.name; } })()')).to eq('SecurityError')
      expect(hits('/b')).to eq(1)
    end

    # (…a History its document's: one read before another document of its origin replaced it is not fully active —
    # Chrome and Firefox, measured 2026-10-31)
    it 'is a SecurityError to use a History read before the window showed another document of its origin' do
      session.execute_script("window.h = w.history; w.location = '/d'")
      expect(read('(() => { try { h.back(); return null; } catch (e) { return e.name; } })()')).to eq('SecurityError')
      expect(read('(() => { try { return h.length; } catch (e) { return e.name; } })()')).to eq('SecurityError')
      expect(read('[w.history === h, w.history.length, w.location.pathname]')).to eq([false, 4, '/d'])
    end

    it 'moves it within its document, firing its own popstate after the script that asked' do
      session.execute_script("w.eval(\"history.pushState({n: 1}, '', '/c2'); addEventListener('popstate', (e) => { document.title = 'pop ' + JSON.stringify(e.state); })\")")
      expect(read("(() => { w.history.back(); return w.document.title; })()")).to eq('c')
      expect(read('[w.document.title, w.location.pathname]')).to eq(['pop null', '/c'])
      expect(hits('/c')).to eq(1)
    end
  end

  context 'of a window its opener made in its own isolate' do
    before do
      session.execute_script("window.w = window.open()")
      session.execute_script("w.location = '/a'")
      session.execute_script("w.location = '/b'")
    end

    # (…its first navigation in place of its initial about:blank: HTML "navigate")
    it "counts its own steps, not its opener's" do
      expect(read('[w.history.length, history.length]')).to eq([2, 1])
    end

    it 'goes back and forward' do
      expect(read("(() => { w.history.back(); return w.location.pathname; })()")).to eq('/b')
      expect(read('[w.location.pathname, w.document.title]')).to eq(['/a', 'a'])
      session.execute_script('w.history.forward()')
      expect(read('[w.location.pathname, w.document.title, w.history.length]')).to eq(['/b', 'b', 2])
      expect(requests.map {|r| r[1] }).to eq(['/page', '/a', '/b', '/a', '/b'])
    end

    it 'keeps its own classic history API state through a traversal, and a document made again' do
      session.execute_script("w.history.pushState({n: 1}, '', '/b2'); w.history.pushState({n: 2}, '', '/b3')")
      expect(read('[w.history.length, history.length, history.state]')).to eq([4, 1, nil])
      session.execute_script("w.addEventListener('popstate', (e) => { w.document.title = 'pop ' + e.state.n; }); w.history.back()")
      expect(read('[w.location.pathname, w.document.title, w.history.state.n]')).to eq(['/b2', 'pop 1', 1])
      session.execute_script('w.history.go(-2)')
      expect(read('[w.location.pathname, w.history.state]')).to eq(['/a', nil])
      session.execute_script('w.history.forward()')
      expect(read('[w.location.pathname, w.document.title, w.history.state]')).to eq(['/b', 'b', nil])
      session.execute_script('w.history.forward()')
      expect(read('[w.location.pathname, w.history.state.n]')).to eq(['/b2', 1])
    end

    it 'is traversed by its own script' do
      session.execute_script("w.eval('history.back()')")
      expect(read('w.location.pathname')).to eq('/a')
    end

    # (…HTML "apply the history step" sets the ongoing navigation to "traversal")
    it 'begins no navigation its own script planned with a traversal' do
      session.execute_script("w.eval(\"history.back(); location = '/z'\")")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/a', 2])
      expect(hits('/z')).to eq(0)
    end

    # (…HTML "navigate": a navigable whose ongoing navigation is "traversal" navigated by none — a task after the one that
    # planned the traversal too; Chrome and Firefox, measured 2026-10-31)
    it 'begins no navigation a later task plans while its traversal is under way' do
      session.execute_script("w.eval(\"history.back(); setTimeout(() => { location = '/z'; }, 0)\")")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/a', 2])
      expect(hits('/z')).to eq(0)
    end

    # (…the first of a task's traversals that replaces its document, those after it let go with it — none left behind
    # where the document it goes to is none: a 204's)
    it 'takes the first of the traversals one task asks for, and is navigated after one whose response is no document' do
      session.execute_script("w.location = '/c'")
      session.execute_script("w.eval('history.go(-2); history.forward()')")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/a', 3])
      session.execute_script("w.location = '/gone'")
      session.execute_script("w.eval('history.back()')")
      session.execute_script("w.eval('history.forward(); history.back()')")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/a', 2])
      session.execute_script("w.eval(\"location = '/z'\")")
      expect(read('[w.location.pathname, w.history.length]')).to eq(['/z', 2])
    end

    it 'records a fragment navigation of it as an entry of its own' do
      session.execute_script("w.location.hash = 'h1'")
      expect(read('[w.history.length, history.length]')).to eq([3, 1])
      session.execute_script("w.addEventListener('hashchange', () => { w.document.title = 'hash:' + w.location.hash; }); w.history.back()")
      expect(read('[w.location.href, w.document.title]')).to eq(['http://a.test/b', 'hash:'])
    end

    # (…its window's: the one session history its tree has, the window's document moved by it)
    it "traverses its window's history from a frame of it" do
      session.execute_script("w.location = '/framed'")
      session.execute_script("w.history.pushState({n: 1}, '', '/p1'); w.addEventListener('popstate', () => { w.document.title = 'pop'; })")
      session.execute_script('w.frames[0].history.back()')
      expect(read('[w.location.pathname, w.document.title, w.frames[0].location.pathname, w.history.length]')).to eq(['/framed', 'pop', '/inner', 4])
    end
  end

  # (…HTML "navigate" with a POST resource, the steps after the source snapshot continuing as the window's task)
  it 'posts a form to a window of another isolate by its name' do
    session.execute_script(<<~JS)
      window.w = window.open('/a', 'named');
      document.body.insertAdjacentHTML('beforeend', '<form target=named method=post action=/posted><input name=k value=v></form>');
      document.forms[0].submit();
    JS
    expect(read('[w.location.pathname, w.history.length]')).to eq(['/posted', 2])
    expect(session.windows.size).to eq(2)
    expect(requests.last).to eq(['POST', '/posted', 'k=v', 'http://a.test'])
    session.execute_script('w.history.back()')
    session.execute_script('w.history.forward()')
    expect(requests.last).to eq(['POST', '/posted', 'k=v', 'http://a.test'])
  end

  context 'navigated to a javascript: URL by another window' do
    it 'runs it in a window of the same origin as a task of its own' do
      session.execute_script("window.w = window.open('/a')")
      expect(read("(() => { w.location = 'javascript:document.title = \"ran\"'; return w.document.title; })()")).to eq('a')
      expect(read('[w.document.title, w.location.pathname, w.history.length]')).to eq(['ran', '/a', 1])
    end

    # (…HTML "navigate to a javascript: URL": its initiator's origin against the active document's as its task runs)
    it 'runs none in a window of another origin' do
      session.execute_script("window.w = window.open('http://b.test/far')")
      session.execute_script("w.location = 'javascript:document.title = \"ran\"'")
      session.within_window(session.windows.last) do
        expect(session).to have_title('far')
      end
    end

    # (…the ongoing navigation of the window, which a later one replaces: "if targetNavigable's ongoing navigation is no
    # longer navigationId, then return")
    it 'runs none a later navigation replaced, and replaces an earlier one' do
      session.execute_script("window.w = window.open('/a')")
      session.execute_script("w.location = 'javascript:document.title = \"ran\"'; w.location = '/c'")
      expect(read('[w.document.title, w.location.pathname]')).to eq(['c', '/c'])
      session.execute_script("w.location = '/d'; w.location = 'javascript:document.title = \"ran\"'")
      expect(read('[w.document.title, w.location.pathname]')).to eq(['ran', '/c'])
      expect(hits('/d')).to eq(0)
    end
  end
end
