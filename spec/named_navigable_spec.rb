require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A link's or a form's target name chooses the navigable whose target name it is (HTML "rules for choosing a navigable",
# navigables.rs `findNavigable`) — any frame of the page, in the order Chrome searches (FrameTree::FindFrameForNavigation:
# the current navigable and its descendants, then the rest of the page), a frame in a shadow tree included; a name no
# navigable has opens a new window. A frame's target name is its navigable's: made from its container's `name`, renamed
# by `window.name`, kept across its navigations. Chrome 2026-10-16, each figure below.
RSpec.describe 'choosing a navigable by name' do
  include PollUntil

  NAVIGABLE_PAGES = {
    '/'   => '<a id="l1" href="/x1" target="b">b</a> <a id="l2" href="/x2" target="renamed">renamed</a> ' \
             '<a id="l3" href="/x3" target="s">s</a> <a id="l4" href="/x4" target="B">B</a> ' \
             '<form id="fg" action="/fg" target="b"><input name="q" value="1"><button>get</button></form>' \
             '<form id="fp" action="/fp" method="post" target="b"><input name="q" value="2"><button>post</button></form>' \
             '<div id="h"></div><iframe name="a" src="/a"></iframe><iframe id="ren" src="/r"></iframe>' \
             '<iframe name="dup" src="/d1"></iframe>' \
             '<script>document.getElementById("h").attachShadow({mode: "open"}).innerHTML = \'<iframe name="s" src="/d3"></iframe>\'</script>',
    '/a'  => '<iframe name="b" src="/b"></iframe><iframe name="dup" src="/d2"></iframe>' \
             '<a id="sib" href="/x5" target="renamed">renamed</a> <a id="own" href="/x6" target="dup">dup</a>',
    '/r'  => '<script>window.name = "renamed"</script>'
  }.freeze

  def session_with_log
    log = []
    s = simulated_session(->(env) {
      log << [env['REQUEST_METHOD'], env['PATH_INFO'], env['QUERY_STRING'], env['HTTP_REFERER']]
      body = NAVIGABLE_PAGES[env['PATH_INFO']] || "<p id=\"p\">#{env['PATH_INFO']}</p>"
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    })
    s.visit '/'
    [s, log]
  end

  def paths(s)
    s.evaluate_script(<<~JS)
      (() => {
        const p = (w) => w ? w.location.pathname : null;
        const shadow = document.getElementById('h').shadowRoot.querySelector('iframe').contentWindow;
        return [p(frames[0]), p(frames[0].frames[0]), p(frames[0].frames[1]), p(frames[1]), p(frames[2]), p(shadow)];
      })()
    JS
  end

  # Chrome: a grandchild by its container's name; a frame by the name it gave itself; a frame in a shadow tree (which
  # `window.length` does not count); none of them a new window, and no container's `src` changed.
  it 'finds a frame anywhere in the page by its target name' do
    s, = session_with_log
    s.find('#l1').click
    s.find('#l2').click
    s.find('#l3').click
    expect(paths(s)).to eq(['/a', '/x1', '/d2', '/x2', '/d1', '/x3'])
    expect(s.windows.size).to eq(1)
    expect(s.evaluate_script('[window.length, document.getElementById("ren").getAttribute("src")]')).to eq([3, '/r'])
    # (…a name is case-sensitive: `B` names no navigable, and opens a new window)
    s.find('#l4').click
    expect(s.windows.size).to eq(2)
  end

  # Chrome: from frame `a`, `dup` is its own child's (its subtree first), not the page's; a sibling of its parent's is
  # found in the rest of the page; the Referer is the document the link is in.
  it "prefers the current frame's subtree, then the page" do
    s, log = session_with_log
    s.within_frame(0) do
      s.find('#own').click
      s.find('#sib').click
    end
    expect(paths(s)).to eq(['/a', '/b', '/x6', '/x5', '/d1', '/d3'])
    expect(log.select {|_, path| %w[/x5 /x6].include?(path) }.map(&:last)).to eq(['http://www.example.com/a'] * 2)
  end

  # A form's target chooses as a link's does: a GET and a POST into a grandchild frame.
  it "submits a form into the frame its target names" do
    s, log = session_with_log
    s.within('#fg') { s.click_button 'get' }
    expect(paths(s)[1]).to eq('/fg')
    s.within('#fp') { s.click_button 'post' }
    expect(paths(s)[1]).to eq('/fp')
    expect(log.select {|_, path| %w[/fg /fp].include?(path) }.map {|m, path, q,| [m, path, q] }).to eq([['GET', '/fg', 'q=1'], ['POST', '/fp', '']])
    expect(s.windows.size).to eq(1)
  end

  # Chrome: a frame's target name is its navigable's — a changed `name` attribute renames no window, a name the frame
  # gave itself outlives its navigation (and the attribute's removal); `window[name]` finds a frame by it.
  it "keeps a frame's target name as its navigable's" do
    s, = session_with_log
    expect(s.evaluate_script(<<~JS)).to eq(['a', 'kept', true, false])
      (() => {
        const f = document.querySelector('iframe[name="a"]');
        f.setAttribute('name', 'other');
        const attr = f.contentWindow.name;
        f.contentWindow.name = 'kept';
        f.removeAttribute('name');
        return [attr, f.contentWindow.name, window.kept === f.contentWindow, 'a' in window];
      })()
    JS
    s.execute_script('frames[0].frameElement.src = "/x7"')
    expect(poll_until { s.evaluate_script('[frames[0].location.pathname, frames[0].name]').then {|v| v if v[0] == '/x7' } }).to eq(['/x7', 'kept'])
  end

  def session_for(pages)
    log = []
    s = simulated_session(->(env) {
      log << [env['PATH_INFO'], env['HTTP_REFERER']]
      body = pages[env['PATH_INFO']] || "<p id=\"p\">#{env['PATH_INFO']}</p>"
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    })
    s.visit '/p'
    [s, log]
  end

  # Chrome: a document under a `sandbox` may navigate its own navigable and its descendants alone ("allowed by sandboxing
  # to navigate") — a link and a form whose target names a sibling of its frame leave the sibling as it was, and open
  # no window.
  it 'navigates nothing a sandbox keeps the frame from navigating' do
    s, log = session_for(
      '/p' => '<iframe id="sb" sandbox="allow-scripts allow-same-origin" src="/s"></iframe><iframe name="other" src="/o"></iframe>',
      '/s' => '<a id="go" href="/x" target="other">go</a><form action="/fx" target="other"><button>sub</button></form>'
    )
    s.within_frame(s.find('#sb')) do
      s.find('#go').click
      s.click_button 'sub'
    end
    expect([s.evaluate_script('frames[1].location.pathname'), s.windows.size]).to eq(['/o', 1])
    expect(log.map(&:first)).not_to include('/x', '/fx')
  end

  # The Referer is the document the link was followed in as it was followed — not as it is once the frame's own
  # navigation, which its click handler started, has replaced it — under the policy its `rel` / `referrerpolicy` sets (a
  # form's `rel` too).
  it "sends the Referer of the document the link was followed in, under the link's policy" do
    s, log = session_for(
      '/p' => '<a id="nr" href="/x1" target="b" rel="noreferrer">n</a> <a id="or" href="/x2" target="b" referrerpolicy="origin">o</a>' \
              '<form action="/x3" target="b" rel="noreferrer"><button>f</button></form>' \
              '<iframe name="a" src="/a"></iframe><iframe name="b" src="/b"></iframe>' \
              '<iframe id="sb" sandbox="allow-scripts" src="/s"></iframe>',
      '/s' => '<a id="up" href="/x4" target="c" referrerpolicy="unsafe-url">u</a><iframe name="c"></iframe>',
      '/a' => %(<a id="go" href="/x" target="b" onclick="location.href='/self'">go</a>)
    )
    s.execute_script('frames[0].document.getElementById("go").click()')
    expect(poll_until { s.evaluate_script('frames[1].location.pathname').then {|v| v if v == '/x' } }).to eq('/x')
    s.find('#nr').click
    s.find('#or').click
    s.click_button 'f'
    # (…and a document of an opaque origin — a sandbox's — refers as none, whatever policy its link sets)
    s.within_frame(s.find('#sb')) { s.find('#up').click }
    expect(poll_until { log.find {|path,| path.start_with?('/x4') } }).to be_truthy
    expect(log.select {|path,| %w[/x /x1 /x2].include?(path) || path.start_with?('/x3', '/x4') }).to eq(
      [['/x', 'http://www.example.com/a'], ['/x1', nil], ['/x2', 'http://www.example.com/'], ['/x3', nil], ['/x4', nil]]
    )
  end

  # HTML §7.2.2.3: a frame's self-given name is its parent window's named property only where the frame's document is
  # same origin with the parent's (Chrome: a cross-origin frame's is not), its container's `name` always.
  it "hides a cross-origin frame's own name from its parent" do
    s, = session_for(
      '/p' => '<iframe name="f" src="http://other.test/c"></iframe><iframe name="a" src="/r"></iframe>',
      '/c' => '<script>window.name = "zz"</script>',
      '/r' => '<script>window.name = "b"</script>'
    )
    s.evaluate_script('frames[0].length')
    expect(s.evaluate_script('["zz" in window, window.b === frames[1]]')).to eq([false, true])
  end

  # A frame removed has no browsing context: its window has no name, and none to set.
  it "keeps no name for a removed frame's window" do
    s, = session_for('/p' => '<iframe name="a" src="/c"></iframe>')
    expect(s.evaluate_script(<<~JS)).to eq(['a', ''])
      (() => {
        const f = document.querySelector('iframe'), w = f.contentWindow, before = w.name;
        f.remove();
        w.name = 'q';
        return [before, w.name];
      })()
    JS
  end

  # A frame made in one document and inserted into another's is that document's child navigable: entered there and
  # navigated by a link of its own, it keeps its realm (the navigable's container found where it now is).
  it 'navigates a frame inserted into another document' do
    s, = session_for('/p' => '<iframe id="host" src="/h"></iframe>')
    s.evaluate_script('frames[0].length')
    s.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.id = 'adopted';
      document.getElementById('host').contentDocument.body.append(f);
      f.contentWindow.document.body.innerHTML = '<a id="go" href="/d">go</a>';
    JS
    s.within_frame(s.find('#host')) do
      s.within_frame(s.find('#adopted')) do
        s.find('#go').click
        expect(s).to have_css('#p', text: '/d')
      end
    end
    expect(s.evaluate_script('frames[0].frames[0].location.pathname')).to eq('/d')
  end

  # A callback of a window `window.open` made, or of a frame in it, is runnable as long as the window is open: a
  # NodeIterator's filter from either runs over the page's document and the window's (DOM "the callback is no longer
  # runnable" only where its realm left the page's browsing-context tree — a removed frame's).
  it "runs a filter of an opened window's frame" do
    s, = session_for('/p' => '<p>main</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const pop = window.open();
        const frame = pop.document.body.appendChild(pop.document.createElement('iframe')).contentWindow;
        const run = (doc, filter) => { try { doc.createNodeIterator(doc.body, 1, filter).nextNode(); return 'ok'; } catch (e) { return e.name; } };
        return [
          run(document, pop.eval('(function () { return 1; })')),
          run(pop.document, frame.eval('(function () { return 1; })')),
          run(document, frame.eval('(function () { return 1; })'))
        ];
      })()
    JS
    expect(got).to eq(%w[ok ok ok])
  end

  # A frame's `frameElement` is its navigable's container: there from its document's first script on — a load handler
  # finds it by it — and null once the frame is removed, its navigable with it (HTML §7.2.3.4).
  it "answers a frame's frameElement from its navigable" do
    s, = session_for('/p' => '<iframe id="f" src="/c"></iframe>', '/c' => '<script>window.seen = frameElement && frameElement.id</script>')
    expect(s.evaluate_script(<<~JS)).to eq(['f', true, nil])
      (() => {
        const f = document.getElementById('f'), w = f.contentWindow;
        const during = w.seen, same = w.frameElement === f;
        f.remove();
        return [during, same, w.frameElement];
      })()
    JS
  end

  # …and the old document's teardown handlers — a frame navigated away from — still have it: the navigable outlives its
  # document's beforeunload / pagehide / unload (Chrome; Firefox too). A frame removed fires none of them: HTML "destroy
  # a child navigable" unloads no document (Chrome does, the spec over it).
  it "keeps a frame's frameElement through its document's teardown" do
    child = '<script>for (const t of ["beforeunload", "pagehide", "unload"]) addEventListener(t, () => parent.L.push(t + ":" + (frameElement && frameElement.id)));</script>'
    s, = session_for('/p' => '<script>window.L = []</script><iframe id="a" src="/c"></iframe><iframe id="b" src="/c"></iframe>', '/c' => child)
    s.evaluate_script('frames[1].length')
    s.execute_script('document.getElementById("a").remove(); document.getElementById("b").src = "/d"')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 3 } }).to eq(%w[beforeunload:b pagehide:b unload:b])
  end

  # …and a teardown handler re-navigating its own frame is ignored — HTML "navigate" with the document's unload counter
  # above 0 — rather than tearing the document down again (its unload fired once; Chrome).
  it 'ignores a navigation a frame starts from its own unload' do
    child = '<script>addEventListener("unload", () => { parent.L.push("unload"); if (frameElement) frameElement.src = "/d"; });</script>'
    s, = session_for('/p' => '<script>window.L = []</script><iframe id="x" src="/c"></iframe>', '/c' => child)
    s.evaluate_script('frames[0].length')
    s.execute_script('document.getElementById("x").src = "/e"')
    expect(poll_until { s.evaluate_script('L').then {|l| l unless l.empty? } }).to eq(%w[unload])
    s.execute_script('document.getElementById("x").remove()')
    expect(s.evaluate_script('L')).to eq(%w[unload])
  end

  # …nor does a teardown handler removing its own frame begin the teardown again: its pagehide and unload fire once.
  it "fires a frame's teardown once when a handler of it removes the frame" do
    child = '<script>for (const t of ["beforeunload", "pagehide", "unload"]) addEventListener(t, () => { parent.L.push(t); if (t === "beforeunload") frameElement.remove(); });</script>'
    s, = session_for('/p' => '<script>window.L = []</script><iframe id="x" src="/c"></iframe>', '/c' => child)
    s.evaluate_script('frames[0].length')
    s.execute_script('document.getElementById("x").src = "/e"')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 3 } }).to eq(%w[beforeunload pagehide unload])
  end

  # A frame the host navigates — its `location` set, which the host fetches and rebuilds the realm for — unloads its old
  # document as any navigation does: beforeunload, pagehide, unload, its frameElement the container; and every
  # beforeunload of its frames' documents before any is unloaded — the same order a `src` change has (Chrome, both).
  def unload_logger(name)
    %(<script>for (const t of ["beforeunload", "pagehide", "unload"]) addEventListener(t, () => top.L.push("#{name}:" + t + ":" + (frameElement && frameElement.id)));</script>)
  end

  {
    'the host navigates' => 'frames[0].location = "http://www.example.com/d"',
    'its src changed'    => 'document.getElementById("c").src = "/d"'
  }.each do |how, script|
    it "unloads a frame's document and its frames' when #{how}" do
      s, = session_for(
        '/p' => '<script>window.L = []</script><iframe id="c" src="/c"></iframe>',
        '/c' => unload_logger('c') + '<iframe id="g" src="/g"></iframe>',
        '/g' => unload_logger('g')
      )
      s.evaluate_script('frames[0].frames[0].document.body.textContent')
      s.execute_script(script)
      expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 6 } }).to eq(%w[
        c:beforeunload:c
        g:beforeunload:g
        c:pagehide:c
        c:unload:c
        g:pagehide:g
        g:unload:g
      ])
    end
  end

  # A frame of the document being unloaded was asked with it: a teardown handler re-navigating that frame asks it no
  # second time.
  it "asks a frame of a document being unloaded nothing more when a teardown handler navigates it" do
    s, = session_for(
      '/p' => '<script>window.L = []</script><iframe id="c" src="/c"></iframe>',
      '/c' => unload_logger('c') + '<script>addEventListener("unload", () => { document.getElementById("g").src = "/e" })</script><iframe id="g" src="/g"></iframe>',
      '/g' => unload_logger('g')
    )
    s.evaluate_script('frames[0].frames[0].document.body.textContent')
    s.execute_script('frames[0].location = "http://www.example.com/d"')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 6 } }).to eq(%w[
      c:beforeunload:c
      g:beforeunload:g
      c:pagehide:c
      c:unload:c
      g:pagehide:g
      g:unload:g
    ])
  end

  # …and one a beforeunload handler re-navigates — the document above it asked, not yet unloaded — is asked itself, for
  # its own navigation, and again with the tree; each document is unloaded once, in whichever order the two navigations
  # commit (Chrome: c:bu, g:bu, g:bu, then g's pagehide / unload and c's, the frame's response the first in).
  it "asks a frame a beforeunload handler navigates" do
    s, = session_for(
      '/p' => '<script>window.L = []</script><iframe id="c" src="/c"></iframe>',
      '/c' => unload_logger('c') + '<script>addEventListener("beforeunload", () => { document.getElementById("g").src = "/e" })</script><iframe id="g" src="/g"></iframe>',
      '/g' => unload_logger('g')
    )
    s.evaluate_script('frames[0].frames[0].document.body.textContent')
    s.execute_script('frames[0].location = "http://www.example.com/d"')
    log = poll_until { s.evaluate_script('L').then {|l| l if l.size >= 7 } }
    expect(log.first(3)).to eq(%w[c:beforeunload:c g:beforeunload:g g:beforeunload:g])
    expect(log.drop(3)).to contain_exactly('c:pagehide:c', 'c:unload:c', 'g:pagehide:g', 'g:unload:g')
  end

  # A redirect's Location is parsed against the URL of the response that carries it (Fetch "HTTP-redirect fetch") —
  # not the document the navigation started from — for a frame's form POST and for the top-level navigation alike.
  it "resolves a redirect's relative Location against the request URL" do
    s = simulated_session(->(env) {
      case env['PATH_INFO']
      when '/sub/c'    then [200, {'content-type' => 'text/html'}, ['<form method="post" action="post"></form>']]
      when '/sub/post' then [303, {'location' => 'done'}, []]
      when '/hop/a'    then [302, {'location' => 'b'}, []]
      when '/hop/b'    then [302, {'location' => 'c'}, []]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><iframe src=\"/sub/c\"></iframe><p>#{env['PATH_INFO']}</p>"]]
      end
    })
    s.visit '/p'
    s.evaluate_script('frames[0].length')
    s.execute_script('frames[0].document.forms[0].requestSubmit()')
    expect(poll_until { s.evaluate_script('frames[0].location.pathname').then {|path| path if path != '/sub/c' } }).to eq('/sub/done')
    s.visit '/hop/a'
    expect(s.current_path).to eq('/hop/c')
  end

  # …an absolute one by the URL parser as well: its host lowercased, its path's dot segments removed and the rest
  # percent-encoded — the request the app is handed, and the URL the session reports, the page's own `location`.
  it "parses a redirect's absolute Location" do
    paths = []
    s = simulated_session(->(env) {
      paths << env['PATH_INFO']
      next [302, {'location' => 'HTTP://WWW.EXAMPLE.COM/a/../caf%C3%A9 x'}, []] if env['PATH_INFO'] == '/start'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p>ok</p>']]
    })
    s.visit '/start'
    expect(s.current_url).to eq('http://www.example.com/caf%C3%A9%20x')
    expect(s.evaluate_script('location.href')).to eq(s.current_url)
    expect(paths.last).to eq('/caf%C3%A9%20x')
  end

  # HTML: whether unloading is canceled is asked before the navigation fetches anything, the document unloaded once the
  # response is in — a cookie its beforeunload sets goes with the request, its unload's does not (Chrome).
  it 'fires beforeunload before the request a host navigation of a frame makes, and unload after it' do
    cookies = {}
    s = simulated_session(->(env) {
      cookies[env['PATH_INFO']] = env['HTTP_COOKIE']
      body = {
        '/p' => '<iframe id="c" src="/c"></iframe>',
        '/c' => '<script>addEventListener("beforeunload", () => { document.cookie = "bu=1; path=/" }); addEventListener("unload", () => { document.cookie = "un=1; path=/" })</script>'
      }[env['PATH_INFO']] || '<p>d</p>'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    })
    s.visit '/p'
    s.evaluate_script('frames[0].length')
    s.execute_script('frames[0].location = "http://www.example.com/d"')
    expect(poll_until { s.evaluate_script('1') && cookies['/d'] }).to eq('bu=1')
  end

  # …a `src` change the same: its document asked at once, unloaded when the response is in — its window the frame's
  # until then, a second change asking it again (Chrome: beforeunload twice, `contentWindow` the old window, the old
  # document's text, one unload), and a beforeunload handler rewriting `src` a navigation of its own, ignored.
  it 'keeps a frame on its document until the response of a src navigation is in' do
    cookies = {}
    s = simulated_session(->(env) {
      cookies[env['PATH_INFO']] = env['HTTP_COOKIE']
      body = {
        '/p' => '<script>window.L = []</script><iframe id="c" src="/c"></iframe>',
        '/c' => '<script>for (const t of ["beforeunload", "pagehide", "unload"]) addEventListener(t, () => { parent.L.push(t); document.cookie = t + "=1; path=/" }); addEventListener("beforeunload", () => { frameElement.src = "/x" })</script><p>c</p>'
      }[env['PATH_INFO']] || "<p>#{env['PATH_INFO']}</p>"
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    })
    s.visit '/p'
    s.evaluate_script('frames[0].document.body.textContent')
    expect(s.evaluate_script(<<~JS)).to eq([true, 'c', %w[beforeunload beforeunload]])
      (() => {
        const f = document.getElementById('c'), w = f.contentWindow;
        f.src = '/d';
        const read = [f.contentWindow === w, f.contentDocument.body.textContent];
        f.src = '/e';
        return [...read, L.slice()];
      })()
    JS
    expect(poll_until { s.evaluate_script('frames[0].document.body.textContent').then {|text| text if text == '/e' } }).to eq('/e')
    expect(s.evaluate_script('L')).to eq(%w[beforeunload beforeunload pagehide unload])
    expect(cookies['/e']).to eq('beforeunload=1')
    expect(cookies).not_to have_key('/x')
  end

  # A navigation superseded before it commits is none: the frame's element fires one `load` for two `src` writes, its
  # session history one entry, the document left the one a traversal back reaches — and a `src` removed navigates it to
  # about:blank, the URL it no longer has fetched by nothing (HTML "process the iframe attributes"; Chrome: one `load`
  # each, about:blank).
  it 'commits one navigation for writes superseded before the response is in' do
    s, log = session_for(
      '/p' => '<script>window.L = []</script><iframe id="c" src="/c" onload="L.push(this.contentDocument.body.textContent)"></iframe>',
      '/c' => '<p>c</p>'
    )
    poll_until { s.evaluate_script('L.length').then {|n| n if n == 1 } }
    s.execute_script('const f = document.getElementById("c"); f.src = "/d"; f.src = "/e"')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 2 } }).to eq(%w[c /e])
    s.execute_script('frames[0].history.back()')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 3 } }).to eq(%w[c /e c])
    s.execute_script('const f = document.getElementById("c"); f.src = "/x"; f.removeAttribute("src")')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 4 } }).to eq(['c', '/e', 'c', ''])
    expect(s.evaluate_script('frames[0].location.href')).to eq('about:blank')
    expect(log.map(&:first)).not_to include('/d', '/x')
  end

  # A container removed and inserted again gets a new navigable, navigated afresh — its document fetched again and its
  # `load` fired — while one moved before its first load fires that load once (HTML: insertion creates a child navigable
  # and processes the iframe attributes; Chrome: `load` again on re-insertion, one for a frame moved before it loaded).
  it 'navigates a frame inserted again afresh' do
    s, log = session_for(
      '/p' => '<script>window.L = []</script><iframe id="c" src="/c" onload="L.push(this.contentDocument.body.textContent)"></iframe>',
      '/c' => '<p>c</p>'
    )
    poll_until { s.evaluate_script('L.length').then {|n| n if n == 1 } }
    s.execute_script('const f = document.getElementById("c"); f.remove(); document.body.appendChild(f)')
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 2 } }).to eq(%w[c c])
    expect(log.map(&:first).count('/c')).to eq(2)
    s.execute_script(<<~JS)
      const f = document.createElement('iframe');
      f.src = '/d';
      f.onload = () => L.push('moved:' + f.contentDocument.body.textContent);
      document.body.appendChild(f);
      document.body.appendChild(document.createElement('div')).appendChild(f);
    JS
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 3 } }).to eq(%w[c c moved:/d])
    s.evaluate_script('1')
    expect(s.evaluate_script('L.length')).to eq(3)
  end

  # …and one its own load handler inserts again on every load navigates again on every load, paced as a response paces
  # it — the clock moving between two of them — rather than all at one instant, a realm built for every turn until the
  # isolate ran out of memory (Chrome loops too, ~100 loads a second).
  it 'paces a frame its load handler inserts again on every load' do
    s, = session_for(
      '/p' => '<script>window.N = 0</script><iframe id="c" src="/c"></iframe><script>const f = document.getElementById("c"); f.onload = () => { N++; f.remove(); document.body.appendChild(f) }</script>',
      '/c' => '<p>c</p>'
    )
    first = poll_until { s.evaluate_script('N').then {|n| n if n.positive? } }
    expect(poll_until { s.evaluate_script('N').then {|n| n if n > first } }).to be > first
    expect(s.evaluate_script('N')).to be < 10_000
  end

  # A frame an unload handler of its own removed is gone, its navigation with it: the response's document never runs,
  # nor is a realm left for it (Chrome).
  it 'commits no document into a frame a teardown handler removed' do
    s, = session_for(
      '/p' => '<script>window.L = []</script><iframe id="c" src="/c"></iframe>',
      '/c' => '<script>addEventListener("unload", () => { frameElement.remove() })</script>',
      '/d' => '<script>parent.L.push("ran")</script>'
    )
    s.evaluate_script('frames[0].length')
    s.execute_script('frames[0].location = "http://www.example.com/d"')
    expect(poll_until { s.evaluate_script('document.querySelectorAll("iframe").length').then {|n| n if n.zero? } }).to eq(0)
    s.evaluate_script('1')
    expect(s.evaluate_script('[L, frames.length]')).to eq([[], 0])
    expect(s.driver.browser.instance_variable_get(:@runtime).frame_realm_ids).to be_empty
  end

  # A frame's session history entry keeps its form state as the document's pagehide handler left it — what a traversal
  # back restores (Chrome).
  it 'restores the form state a pagehide handler left' do
    s, = session_for(
      '/p' => '<iframe id="c" src="/c"></iframe>',
      '/c' => '<script>addEventListener("pagehide", () => { document.querySelector("input").value = "left" })</script><form action="/d"><input id="i" name="i"></form>'
    )
    s.evaluate_script('frames[0].document.body.textContent')
    s.execute_script('frames[0].document.getElementById("i").value = "typed"; frames[0].document.forms[0].requestSubmit()')
    poll_until { s.evaluate_script('frames[0].location.pathname').then {|path| path if path == '/d' } }
    s.execute_script('frames[0].history.back()')
    expect(poll_until { s.evaluate_script('frames[0].document.getElementById("i") && frames[0].document.getElementById("i").value') }).to eq('left')
  end
end
