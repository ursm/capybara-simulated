# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "navigate" runs a few steps at once and the rest in parallel with the event loop: its document asked whether it
# may be unloaded (HTML "checking if unloading is canceled" queues a global task to fire `beforeunload`), its response fetched, that document unloaded
# and the next one made ("attempt to populate the history entry's document", "finalize a cross-document navigation"). So
# what is due before all that runs first, and the frame's document and window are the old ones until then: here, a task
# of the agent's event loop behind every other due at its instant (timers.rs `BEHIND`). Each page below as Chrome 157 and
# Firefox 159 ran it (fn_*.html, 2026-11-06, two runs each). They ask `beforeunload` inside `navigate`, before the setter
# returns, where HTML queues it: `set old:bu ret`, here `set ret … P0 old:bu`.
RSpec.describe 'a frame navigation as tasks' do
  def session(pages)
    simulated_session(->(env) {
      query = env['QUERY_STRING'].to_s
      key   = env['PATH_INFO'] + (query.empty? ? '' : "?#{query}")
      body  = pages[key] || pages[env['PATH_INFO']]
      next [204, {}, []] if body == :no_content

      [body ? 200 : 404, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    })
  end

  def child_log = <<~HTML
    <title>child</title><script>
      const tag = location.search.slice(1) || 'sd';
      const log = (s) => top.L.push(tag + ':' + s);
      log('script');
      for (const type of ['load', 'beforeunload', 'pagehide', 'unload']) addEventListener(type, () => log(type));
      setTimeout(() => log('t0'), 0);
    </script><a id="a" href="/child?viaA">x</a>
  HTML

  # A page with a frame at `/child?old`, whose `run(f)`, the page quiet by then, logs what comes in `L`.
  def log_of(run, attrs: 'src="/child?old"', pages: {})
    s = session({
      '/child' => child_log,
      '/'      => <<~HTML
        <title>page</title><iframe id="f" name="fr" #{attrs}></iframe><pre id="out"></pre>
        <form id="fm" target="fr" action="/child"><input type="hidden" name="viaF" value="1"></form>
        <a id="ln" target="fr" href="/child?viaL">l</a>
        <script>
          const L = window.L = [];
          const U = (f) => { const d = f.contentDocument; return d ? String(d.URL).replace(/^.*\\//, '') : 'null'; };
          const timers = () => {
            queueMicrotask(() => L.push('M'));
            setTimeout(() => L.push('P0'), 0);
            setTimeout(() => L.push('P5'), 5);
            setTimeout(() => L.push('P40'), 40);
          };
          onload = () => setTimeout(() => {
            L.length = 0;
            const f = document.getElementById('f');
            #{run}
            setTimeout(() => { document.getElementById('out').textContent = L.join(' '); document.title = 'done'; }, 500);
          }, 50);
        </script>
      HTML
    }.merge(pages))
    s.visit '/'
    expect(s).to have_title('done', wait: 10)
    s.find('#out', visible: :all).text(:all).split(' ')
  end

  # A `srcdoc` set: zero timers queued after it run before the old document goes.
  # Chrome: set old:bu ret M P0 old:ph old:un new:script new:load P-load new:t0 P5 P40. Firefox: the same but for its new:t0
  # before new:load, and a P1 in or out by a run.
  it 'unloads the old document of a srcdoc set after the zero timers queued behind it' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load:' + U(f));
      L.push('set');
      f.srcdoc = "<script>top.L.push('new:script'); addEventListener('load', () => top.L.push('new:load')); setTimeout(() => top.L.push('new:t0'), 0)<\\/script>";
      L.push('ret:' + U(f));
      timers();
    JS
    expect(log).to eq(%w[
      set ret:child?old M P0
      old:beforeunload old:pagehide old:unload
      new:script new:load P-load:about:srcdoc new:t0 P5 P40
    ])
  end

  # …and a `src` set the same, its window and its document the old ones until then, and the same window after.
  # Chrome and Firefox: `ret:…old:sameW=true:sameD=true M P0 P0read:…old`, `P-load:…new:sameW=true`.
  it "keeps the frame's document and window until the navigation's task, and a same-origin frame's WindowProxy after" do
    log = log_of(<<~JS)
      const w = f.contentWindow, d = f.contentDocument;
      f.onload = () => L.push('load:' + U(f) + ':' + (f.contentWindow === w));
      f.src = '/child?new';
      L.push('ret:' + U(f) + ':' + (f.contentWindow === w) + ':' + (f.contentDocument === d));
      setTimeout(() => L.push('P0:' + U(f)), 0);
    JS
    expect(log).to eq(%w[
      ret:child?old:true:true P0:child?old
      old:beforeunload old:pagehide old:unload
      new:script new:load load:child?new:true new:t0
    ])
  end

  # Zero timers chained from one queued behind the `src` set run until their nesting clamp moves the clock on, which ends
  # the navigation's wait. Chrome `c0 … c4` then the old document's pagehide; Firefox `c0 c1 c2`.
  it 'waits for a chain of zero timers no further than their nesting clamp' do
    log = log_of(<<~JS)
      f.src = '/child?new';
      let n = 0;
      const tick = () => { L.push('c' + n++); if (n < 8) setTimeout(tick, 0); };
      setTimeout(tick, 0);
    JS
    expect(log.take(6)).to eq(%w[c0 c1 c2 c3 c4 old:beforeunload])
    expect(log.index('c5')).to be > log.index('new:load')
  end

  # …nor a loop polling for the next document with zero timers awaited, which nests in no timer: the clock stays, and the
  # navigation goes on all the same (WPT replace-before-load/iframe-src), each of its tasks past `BEHIND_WAITS` tasks run at
  # its instant — 128 for a `src`, its document asked and then its commit.
  it 'waits for a loop of awaited zero timers no further than a bounded number of tasks' do
    log = log_of(<<~JS)
      f.src = '/child?new';
      (async () => {
        let polls = 0;
        while (U(f) !== 'child?new' && polls++ < 2000) await new Promise((r) => setTimeout(r, 0));
        L.push(polls < 2000 ? 'reached' : 'starved');
      })();
    JS
    expect(log).to include('reached')
  end

  # A document's `beforeunload` handlers' message to the page comes with that document still the frame's: asking it is a
  # task of its own (WPT compile-event-handler-settings-objects). `event.source` the frame's window.
  it "delivers a beforeunload handler's message with the document still the frame's" do
    log = log_of(<<~JS, attrs: 'src="/uh"', pages: {'/uh' => %(<script>window.name = "n"; addEventListener("beforeunload", () => parent.postMessage("bye", "*"))</script>)})
      addEventListener('message', (e) => L.push(e.data + ':' + e.source.name + ':' + (e.source === f.contentWindow) + ':' + U(f)));
      f.src = '/child?new';
    JS
    expect(log.first).to eq('bye:n:true:uh')
  end

  # A frame's `load` comes before the message its document's `load` handler queues, whoever built it: the parent's own
  # load flushing the build ahead of the navigation's task (WPT redirect-keepalive, localstorage-about-blank-3P).
  it "fires the frame's load before the message its document posted as it loaded, its build flushed by the page's load" do
    s = session(
      '/'  => <<~HTML,
        <title>p</title><pre id="out"></pre><script>
          const L = [];
          addEventListener('message', () => L.push('message'));
          const f = document.createElement('iframe');
          f.src = '/k';
          f.addEventListener('load', () => L.push('load'));
          document.documentElement.appendChild(f);
          setTimeout(() => { document.getElementById('out').textContent = L.join(' '); document.title = 'done'; }, 100);
        </script>
      HTML
      '/k' => '<script>addEventListener("load", () => parent.postMessage("t", "*"))</script>'
    )
    s.visit '/'
    expect(s).to have_title('done', wait: 10)
    expect(s.find('#out', visible: :all).text(:all)).to eq('load message')
  end

  # A second `src` before the first commits cancels it: its response fetched by nothing, its document never made, one
  # `load`. The document asked for each, as each navigation asks before it looks whether it is still the ongoing one.
  # Chrome and Firefox: set old:bu old:bu ret M P0 old:ph old:un b:script b:load P-load:…b.
  it 'cancels a navigation with a second src set before it commits' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load:' + U(f));
      L.push('set');
      f.src = '/child?a';
      f.src = '/child?b';
      L.push('ret:' + U(f));
      timers();
    JS
    expect(log).to eq(%w[
      set ret:child?old M P0
      old:beforeunload old:beforeunload old:pagehide old:unload
      b:script b:load P-load:child?b b:t0 P5 P40
    ])
  end

  # …one from a timer the same, queued ahead of the navigation's task. Chrome and Firefox: `M set2 old:bu ret2 P0 …`.
  it "cancels a navigation with a second src set from a task it let run first" do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load:' + U(f));
      f.src = '/child?a';
      setTimeout(() => { L.push('set2'); f.src = '/child?b'; L.push('ret2:' + U(f)); }, 0);
      setTimeout(() => L.push('P0'), 0);
    JS
    expect(log).not_to include('a:script')
    expect(log.first(3)).to eq(%w[set2 ret2:child?old P0])
    expect(log).to include('b:script', 'P-load:child?b')
  end

  # …and a `srcdoc` after a `src`, which wins whatever the attribute order.
  it 'cancels a src navigation with a srcdoc set' do
    log = log_of(<<~JS)
      f.src = '/child?a';
      f.srcdoc = "<script>top.L.push('sd:script')<\\/script>";
    JS
    expect(log).to include('sd:script')
    expect(log).not_to include('a:script')
  end

  # A frame removed with its navigation queued: nothing of it runs, no `load`. HTML destroys its documents with no
  # pagehide or unload, where Chrome and Firefox fire them inside `remove()` (dom-nodes.js `discardBrowsingContext`,
  # pinned by insertion-removing-steps-iframe).
  it 'drops a queued navigation with its frame removed' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load');
      f.src = '/child?a';
      L.push('ret');
      f.remove();
      L.push('removed');
      timers();
    JS
    expect(log).to eq(%w[ret removed M P0 P5 P40])
  end

  # …and inserted again: a new navigable's navigation, on a task as any other. Chrome and Firefox:
  # `removed back:about:blank M P0 … a:script a:load P-load:…a`.
  it 'makes the new navigation of a frame removed and inserted again on a task' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load:' + U(f));
      f.src = '/child?a';
      const p = f.parentNode;
      f.remove();
      p.appendChild(f);
      L.push('back:' + U(f));
      timers();
    JS
    expect(log).to eq(%w[back:about:blank M P0 a:script a:load P-load:child?a a:t0 P5 P40])
  end

  # …and a handler of the old document's `beforeunload` removing it stops there.
  it 'goes no further where a beforeunload handler removes the frame' do
    log = log_of(<<~JS, attrs: 'src="/uh"', pages: {'/uh' => '<script>addEventListener("beforeunload", () => { top.L.push("bu"); frameElement.remove() })</script>'})
      f.onload = () => L.push('P-load');
      f.src = '/child?a';
      L.push('ret');
      timers();
    JS
    expect(log).to eq(%w[ret M P0 bu P5 P40])
  end

  # A document's own handlers navigating it as it unloads: ignored, its unload counter above 0 (HTML "navigate"). Chrome
  # ignores them, Firefox honours them.
  %w[pagehide unload].each do |type|
    it "ignores a navigation of a frame from its document's #{type} handler" do
      log = log_of(<<~JS, attrs: 'src="/uh"', pages: {'/uh' => %(<script>addEventListener("#{type}", () => { location.href = "/child?via"; frameElement.src = "/child?via2" })</script>)})
        f.src = '/child?new';
      JS
      expect(log).to include('new:script')
      expect(log.join).not_to include('via')
    end
  end

  # A `src` set to a fragment of the document the frame is at navigates within it, at once: nothing unloaded, no `load`
  # (HTML "navigate"). Chrome and Firefox: set ret:…#x M P0 P5 P40.
  it 'navigates to a fragment of the document as the src is set' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load');
      L.push('set');
      f.src = '/child?old#x';
      L.push('ret:' + U(f));
      timers();
    JS
    expect(log).to eq(%w[set ret:child?old#x M P0 P5 P40])
  end

  # about:blank, as `src` or with it removed, is a document the navigation makes on its task like any other. Chrome and
  # Firefox: set ret:…old M P0 old:ph old:un P-load:about:blank … final:about:blank.
  it 'makes the about:blank document a removed src navigates to on the task' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load:' + U(f));
      L.push('set');
      f.removeAttribute('src');
      L.push('ret:' + U(f));
      timers();
      setTimeout(() => L.push('final:' + U(f)), 200);
    JS
    expect(log).to eq(%w[
      set ret:child?old M P0
      old:beforeunload old:pagehide old:unload
      P-load:about:blank P5 P40 final:about:blank
    ])
  end

  # A 204 stays at the document it is at, no `load`, the document asked all the same. Chrome and Firefox:
  # set old:bu ret:…old M P0 P5 P40 final:…old.
  it 'leaves the frame at its document for a response that makes none' do
    log = log_of(<<~JS, pages: {'/n204' => :no_content})
      f.onload = () => L.push('P-load:' + U(f));
      L.push('set');
      f.src = '/n204';
      L.push('ret:' + U(f));
      timers();
      setTimeout(() => L.push('final:' + U(f)), 200);
    JS
    expect(log).to eq(%w[set ret:child?old M P0 old:beforeunload P5 P40 final:child?old])
  end

  # A `javascript:` URL's task is queued at once, ahead of a timer set after it, and its string result's document is made
  # with no asking (HTML "navigate to a javascript: URL"; Chrome asks none, Firefox does).
  it "replaces the document with a javascript: URL's result unasked, on a task" do
    log = log_of(<<~JS)
      window.jsran = () => L.push('JS');
      f.src = "javascript:parent.jsran();'<script>top.L.push(1)<\\/script>'";
      setTimeout(() => L.push('P0'), 0);
    JS
    expect(log).to eq(%w[JS P0 old:pagehide old:unload 1])
  end

  # The session history: an entry as a navigation commits — one of a `srcdoc`'s too — where the frame has a document;
  # replaced where the URL is the document's own (HTML "navigate", `auto`). Chrome and Firefox: `h` up by one at the load,
  # flat across a second `srcdoc`, flat for the frame's first navigation, and the second of two `src` writes the one entry.
  it "adds a session history entry as a srcdoc's navigation commits, and replaces it with the next srcdoc" do
    log = log_of(<<~JS)
      L.push('h0=' + history.length);
      f.srcdoc = '<p>x';
      L.push('ret=' + history.length);
      setTimeout(() => { L.push('h1=' + history.length); f.srcdoc = '<p>y'; }, 100);
      setTimeout(() => L.push('h2=' + history.length), 200);
    JS
    expect(log.grep(/\Ah|ret/)).to eq(%w[h0=1 ret=1 h1=2 h2=2])
  end

  it 'adds no entry for a src set to the URL the frame is at' do
    log = log_of(<<~JS)
      L.push('h0=' + history.length);
      f.src = f.src;
      setTimeout(() => L.push('h1=' + history.length), 100);
    JS
    expect(log.grep(/\Ah/)).to eq(%w[h0=1 h1=1])
  end

  it 'adds one entry for two src sets before the first commits' do
    log = log_of(<<~JS)
      L.push('h0=' + history.length);
      f.src = '/child?a';
      f.src = '/child?b';
      setTimeout(() => L.push('h1=' + history.length), 100);
    JS
    expect(log.grep(/\Ah/)).to eq(%w[h0=1 h1=2])
  end

  it "adds no entry for a frame's first navigation" do
    log = log_of(<<~JS, attrs: '')
      L.push('h0=' + history.length);
      f.src = '/child?a';
      setTimeout(() => L.push('h1=' + history.length), 100);
    JS
    expect(log.grep(/\Ah/)).to eq(%w[h0=1 h1=1])
  end

  # A frame's own `location`, its reload, a link or a form targeting it: what the host takes, at the event loop's
  # navigation turn. Chrome and Firefox: `set [old:bu] ret:…old M P0 [P1] old:ph old:un new:script … P-load:…new new:t0 P5 P40`
  # — the commit well before P40, which ran ahead of it when the host took it only as a whole step ended.
  {
    'its location set'  => ["f.contentWindow.location.href = '/child?new';", 'new'],
    'a link to it'      => ["document.getElementById('ln').click();", 'viaL'],
    'a link in it'      => ["f.contentDocument.getElementById('a').click();", 'viaA'],
    'its reload'        => ['f.contentWindow.location.reload();', 'old'],
    'a form to it'      => ["document.getElementById('fm').submit();", 'viaF=1'],
  }.each do |what, (run, tag)|
    it "commits #{what} behind the zero timers and before the later ones" do
      log = log_of(<<~JS)
        f.onload = () => L.push('P-load:' + U(f));
        L.push('set');
        #{run}
        L.push('ret:' + U(f));
        timers();
      JS
      expect(log).to eq([
        'set', 'ret:child?old', 'M', 'P0',
        'old:beforeunload', 'old:pagehide', 'old:unload',
        "#{tag}:script", "#{tag}:load", "P-load:child?#{tag}", "#{tag}:t0", 'P5', 'P40'
      ])
    end
  end

  # …a form in it, the host's to route. Chrome and Firefox: `M old:bu P0 P1 old:ph old:un viaIF=1:script … P5 P40`.
  it 'commits a form in the frame behind the zero timers and before the later ones' do
    log = log_of(<<~JS)
      const d = f.contentDocument, form = d.createElement('form');
      form.action = '/child';
      form.innerHTML = '<input type="hidden" name="viaIF" value="1">';
      d.body.appendChild(form);
      form.submit();
      timers();
    JS
    expect(log).to eq(%w[M P0 old:beforeunload old:pagehide old:unload viaIF=1:script viaIF=1:load viaIF=1:t0 P5 P40])
  end

  # Two of them, or one and a `src`, in either order: one navigation, the later's. Chrome and Firefox: `… b:script …`.
  {
    'two locations'      => "w.location.href = '/child?a'; w.location.href = '/child?b';",
    'a location, a src'  => "w.location.href = '/child?a'; f.src = '/child?b';",
    'a src, a location'  => "f.src = '/child?a'; w.location.href = '/child?b';"
  }.each do |what, run|
    it "goes to the later of #{what}" do
      log = log_of(<<~JS)
        const w = f.contentWindow;
        #{run}
        setTimeout(() => L.push('P0'), 0);
      JS
      expect(log).not_to include('a:script')
      expect(log.first).to eq('P0')
      expect(log).to include('b:script')
    end
  end

  # A frame removed with its location set: nothing of it runs. Chrome and Firefox: `… ret … removed M P0 P5 P40`, its
  # pagehide and unload apart (above).
  it 'drops the navigation the host plans with its frame removed' do
    log = log_of(<<~JS)
      f.onload = () => L.push('P-load');
      f.contentWindow.location.href = '/child?a';
      L.push('ret');
      f.remove();
      L.push('removed');
      timers();
    JS
    expect(log).to eq(%w[ret removed M P0 P5 P40])
  end

  # A document opened cancels the navigation of its frame: HTML document open steps, "stop loading". Chrome and Firefox:
  # `opened:… P0 … final:…` at the document written, none of the next, its `src`'s or its `location`'s.
  {
    'src'      => "f.src = '/child?new';",
    'location' => "f.contentWindow.location.href = '/child?new';"
  }.each do |what, run|
    it "cancels a queued navigation by its #{what} with the document opened" do
      log = log_of(<<~JS)
        const d = f.contentDocument;
        #{run}
        d.open();
        d.write('written');
        d.close();
        setTimeout(() => L.push('final:' + d.body.textContent + ':' + (f.contentDocument === d)), 200);
      JS
      expect(log).not_to include('new:script')
      expect(log.last).to eq('final:written:true')
    end
  end

  # The session history of a location: an entry as it commits, replaced by a `replace`. Chrome and Firefox: `h` up by one at
  # the end, flat for a `replace`.
  it "adds a session history entry as a location's navigation commits, none for a replace" do
    log = log_of(<<~JS)
      L.push('h0=' + history.length);
      f.contentWindow.location.href = '/child?a';
      L.push('ret=' + history.length);
      setTimeout(() => { L.push('h1=' + history.length); f.contentWindow.location.replace('/child?b'); }, 100);
      setTimeout(() => L.push('h2=' + history.length), 200);
    JS
    expect(log.grep(/\Ah|ret/)).to eq(%w[h0=1 ret=1 h1=2 h2=2])
  end

  # The driver waits for a chain of them, each `load` navigating on, however the steps fall: every one comes before a wait
  # gives up (it stopped at the first where the plan woke nothing).
  it 'keeps the driver waiting through a chain of location navigations' do
    s = session(
      '/'  => <<~HTML,
        <title>p</title><script>
          let n = 0;
          const frames_ = [];
          for (let i = 0; i < 4; i++) {
            const f = document.createElement('iframe');
            f.src = '/a?0';
            f.addEventListener('load', () => {
              if (f.dataset.go !== '1') return;
              if (++n === 16) document.title = 'done';
              if (f.contentWindow.location.search !== '?3') f.contentWindow.location.href = '/a?' + (+f.contentWindow.location.search.slice(1) + 1);
            });
            frames_.push(f);
            document.documentElement.appendChild(f);
          }
          window.go = () => { for (const f of frames_) { f.dataset.go = '1'; f.contentWindow.location.href = '/a?0'; } };
        </script>
      HTML
      '/a' => '<p>a</p>'
    )
    s.visit '/'
    s.evaluate_script('document.querySelectorAll("iframe")[3].contentDocument.URL')
    s.execute_script('go()')
    expect(s).to have_title('done', wait: 10)
  end

  # …and is not held by a frame that navigates itself on every load: its navigations paced as a network's response paces
  # them, the clock moves and the rest of the page goes on with them.
  it 'goes on past a frame navigating itself on every load' do
    s = session(
      '/'     => '<title>p</title><p id="x">x</p><iframe src="/self"></iframe><script>setTimeout(() => { document.title = "done" }, 100)</script>',
      '/self' => '<script>onload = () => location.reload()</script>'
    )
    s.visit '/'
    expect(s).to have_title('done', wait: 10)
    expect(s.find('#x').text).to eq('x')
  end

  # The driver's own wait: a frame entered right after a navigation of it begins is at the next document, its `src` set
  # or a link followed, by a script or by the user.
  it 'enters the document a queued location navigation goes to' do
    s = session('/' => '<iframe id="f" src="/a"></iframe>', '/a' => '<p id="at">a</p>', '/b' => '<p id="at">b</p>')
    s.visit '/'
    s.within_frame('f') { expect(s.find('#at').text).to eq('a') }
    s.execute_script("frames[0].location.href = '/b'")
    s.within_frame('f') { expect(s.find('#at').text).to eq('b') }
  end

  it 'enters the document a clicked link targeting the frame goes to' do
    s = session(
      '/'  => '<a id="go" href="/b" target="fr">go</a><a id="sd" href="#" onclick="document.getElementById(\'f\').srcdoc = \'<p id=at>sd</p>\'; return false">sd</a><iframe id="f" name="fr" src="/a"></iframe>',
      '/a' => '<p id="at">a</p>',
      '/b' => '<p id="at">b</p>'
    )
    s.visit '/'
    s.click_link 'go'
    s.within_frame('f') { expect(s.find('#at').text).to eq('b') }
    s.click_link 'sd'
    s.within_frame('f') { expect(s.find('#at').text).to eq('sd') }
  end

  it 'navigates an entered frame through a link in it, the scope following it' do
    s = session('/' => '<iframe id="f" src="/a"></iframe>', '/a' => '<a href="/b">go</a>', '/b' => '<p id="at">b</p>')
    s.visit '/'
    s.within_frame('f') do
      s.click_link 'go'
      expect(s.find('#at').text).to eq('b')
    end
  end

  # Each navigation's wait its own: what ran before it was queued, and a navigation gone with its realm, count for nothing.
  # Chrome `set old:bu old:ph … Z0 …`, Firefox `set old:bu Z0 … Z4 old:ph …`: no task of the page's is overtaken here for
  # having been preceded by others.
  it "counts a navigation's wait from when it is queued, past one gone with its realm" do
    log = log_of(<<~JS, pages: {'/outer' => '<iframe id="g" src="/child?g"></iframe>'})
      const o = document.createElement('iframe');
      o.src = '/outer';
      o.onload = async () => {
        const P = (ms) => new Promise((r) => setTimeout(r, ms));
        const g = o.contentDocument.getElementById('g');
        g.src = '/child?g2';
        o.remove();
        for (let i = 0; i < 60; i++) await P(1);
        L.length = 0;
        L.push('set');
        f.src = '/child?new';
        for (let i = 0; i < 5; i++) setTimeout(() => L.push('Z' + i), 0);
      };
      document.body.appendChild(o);
    JS
    expect(log.first(7)).to eq(%w[set Z0 Z1 Z2 Z3 Z4 old:beforeunload])
  end

  # A document's opening stops the navigation under way, and one that has none to stop only: a form's planned navigation is
  # none yet, HTML "plan to navigate" queuing it with no ongoing navigation — the document open steps stop loading only "if
  # ongoing navigation is a navigation ID". Firefox goes on with the form's, Chrome cancels it.
  it "goes on with a form's planned navigation of a frame whose document is opened" do
    log = log_of(<<~JS)
      document.getElementById('fm').submit();
      const d = f.contentDocument;
      d.open();
      d.write('<title>opened</title>');
      d.close();
      setTimeout(() => L.push('final:' + U(f)), 200);
    JS
    expect(log).to include('viaF=1:script', 'final:child?viaF=1')
  end

  # …nor a reload (Firefox reloads, Chrome stays at the document opened; "reload pending" and a step on the traversal queue).
  it 'goes on with a reload of a frame whose document is opened' do
    uh = %(<title>u</title><script>top.L.push("uh"); window.go = () => { location.reload(); document.open(); document.write("<title>opened</title>"); document.close() }</script>)
    log = log_of(<<~JS, attrs: 'src="/uh"', pages: {'/uh' => uh})
      f.contentWindow.setTimeout('go()', 0);
      setTimeout(() => L.push('final:' + f.contentDocument.title), 200);
    JS
    expect(log).to eq(%w[uh final:u])
  end

  # A document a host navigation made, its `load` handler setting its container's `src`: that navigation the frame's next,
  # none of the commit's it ran in. Chrome and Firefox: `wl fromload:script fromload:load final:…fromload`.
  {'its location' => "f.contentWindow.location.href = '/wl';", 'a link' => "document.getElementById('ln').href = '/wl'; document.getElementById('ln').click();"}.each do |what, run|
    it "keeps the src a document set of its frame as it loaded, navigated to by #{what}" do
      log = log_of(<<~JS, pages: {'/wl' => "<script>onload = () => { top.L.push('wl'); frameElement.src = '/child?fromload' }</script>"})
        #{run}
        setTimeout(() => L.push('final:' + U(f)), 200);
      JS
      expect(log).to include('wl', 'fromload:script', 'fromload:load', 'final:child?fromload')
    end
  end

  # `stop()`: HTML "stop loading" its navigable, a navigation ID the ongoing one no more. Chrome and Firefox stay at `?old`.
  {
    'its src'       => "f.src = '/child?new';",
    'about:blank'   => "f.src = 'about:blank';",
    'its location'  => "f.contentWindow.location.href = '/child?new';"
  }.each do |what, run|
    it "stops the navigation by #{what} with the frame's window's stop()" do
      log = log_of(<<~JS)
        #{run}
        f.contentWindow.stop();
        setTimeout(() => L.push('final:' + U(f)), 200);
      JS
      expect(log).not_to include('new:script')
      expect(log.last).to eq('final:child?old')
    end
  end

  # …the frame's document's own, its navigation begun in it. Chrome and Firefox stay at `?old`.
  it "stops a frame's navigation of itself with its own stop()" do
    log = log_of(<<~JS)
      f.contentWindow.eval('location.href = "/child?new"; stop()');
      setTimeout(() => L.push('final:' + U(f)), 200);
    JS
    expect(log.last).to eq('final:child?old')
  end

  # …a form's, planned or begun, and a reload, as Chrome and Firefox do, where the text leaves it to inference: `old:bu` at
  # most, `final:…?old`. (A document's opening stops only a navigation ID, and there they part: above.)
  {
    "a form's, begun"   => "document.getElementById('fm').submit(); setTimeout(() => f.contentWindow.stop(), 0);",
    "a form's, planned" => "document.getElementById('fm').submit(); f.contentWindow.stop();",
    'a reload'          => 'f.contentWindow.location.reload(); f.contentWindow.stop();'
  }.each do |what, run|
    it "stops #{what} with the frame's window's stop()" do
      log = log_of(<<~JS)
        #{run}
        setTimeout(() => L.push('final:' + U(f)), 200);
      JS
      expect(log).to eq(%w[final:child?old])
    end
  end

  # …a form the frame's own document submitted: `final:…?old`.
  it "stops a form of the frame's document with its stop()" do
    log = log_of(<<~JS)
      const d = f.contentDocument;
      d.body.innerHTML = '<form action="/child"><input name="b" value="1"></form>';
      d.forms[0].submit();
      f.contentWindow.stop();
      setTimeout(() => L.push('final:' + U(f)), 200);
    JS
    expect(log).to eq(%w[final:child?old])
  end

  # …a frame's by its parent's: "any instances of the fetch algorithm in the context of document", a parent's `src` request's
  # client the parent — and Chrome and Firefox stop them all, its `location`'s, its own script's, a reload, a form, and a
  # frame not built yet, which stays at its initial about:blank.
  {
    'a src'              => "f.src = '/child?new';",
    'a location'         => "f.contentWindow.location.href = '/child?new';",
    "the frame's own"    => "f.contentWindow.eval('location.href = \"/child?new\"');",
    'a reload'           => 'f.contentWindow.location.reload();',
    'a form'             => "document.getElementById('fm').submit();"
  }.each do |what, run|
    it "stops #{what} of a frame with its parent's stop()" do
      log = log_of(<<~JS)
        #{run}
        window.stop();
        setTimeout(() => L.push('final:' + U(f)), 200);
      JS
      expect(log.last).to eq('final:child?old')
      expect(log).not_to include('new:script', 'old:script', 'viaF=1:script')
    end
  end

  it "leaves a frame just inserted at its initial about:blank with its parent's stop()" do
    log = log_of(<<~JS)
      const g = document.createElement('iframe');
      g.src = '/child?new';
      document.body.appendChild(g);
      window.stop();
      setTimeout(() => L.push('g:' + g.contentWindow.location.href), 100);
    JS
    expect(log).to eq(%w[g:about:blank])
  end

  it "stops a frame's frame's navigation with the page's stop()" do
    log = log_of(<<~'JS')
      f.srcdoc = '<iframe id="g" src="/child?g0"></iframe>';
      setTimeout(() => {
        L.length = 0;
        const g = f.contentDocument.getElementById('g');
        g.src = '/child?g1';
        window.stop();
        setTimeout(() => L.push('g:' + g.contentDocument.URL.replace(/^.*\//, '')), 100);
      }, 100);
    JS
    expect(log).not_to include('g1:script')
    expect(log.last).to eq('g:child?g0')
  end

  # A reload a document's opening does not stop goes to the URL `reload()` found: HTML appends its traversal steps then, and
  # the entry they apply to is still the old one, whatever the document's URL becomes. Firefox: `final:?old`; Chrome stays at the
  # document opened. It recursed into the page at the URL `open()` adopted.
  it 'reloads the URL reload() found, not one the opening adopted' do
    log = log_of(<<~JS)
      const w = f.contentWindow;
      w.location.reload();
      w.document.open();
      w.document.write('<title>opened</title>');
      w.document.close();
      setTimeout(() => L.push('final:' + w.location.search), 200);
    JS
    expect(log).to eq(%w[old:script old:load old:t0 final:?old])
  end

  # …at the top level, Chrome and Firefox alike stop it.
  it "stays at the document the page's reload is followed by opening" do
    n = 0
    s = simulated_session(->(_env) {
      n += 1
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><title>p</title><script>onload = () => setTimeout(() => { location.reload(); document.open(); document.write("<title>opened</title>"); document.close() }, 0)</script>']]
    })
    s.visit '/'
    expect(s).to have_title('opened', wait: 5)
    expect(n).to eq(1)
  end

  # `stop()` of a page: its `reload()` (Chrome and Firefox: `n1 stayed`), a form.
  ['location.reload()', 'document.forms[0].submit()'].each do |run|
    it "stops the page's #{run}" do
      n = 0
      s = simulated_session(->(_env) {
        n += 1
        [200, {'content-type' => 'text/html'}, [%(<!DOCTYPE html><meta charset="utf-8"><title>p</title><form action="/f"></form><script>onload = () => setTimeout(() => { #{run}; stop(); setTimeout(() => { document.title = "stayed" }, 100) }, 0)</script>)]]
      })
      s.visit '/'
      expect(s).to have_title('stayed', wait: 5)
      expect(n).to eq(1)
    end
  end

  # …a top-level document's location navigation. Chrome and Firefox stay.
  it "stops the page's location navigation" do
    s = session('/' => '<title>p</title><script>onload = () => setTimeout(() => { location.href = "/other"; stop(); setTimeout(() => { document.title = "stayed" }, 100) }, 0)</script>', '/other' => '<title>other</title>')
    s.visit '/'
    expect(s).to have_title('stayed', wait: 5)
  end

  # HTML "abort a document": its fetches cancelled. An XHR's `abort` and `loadend` come on a task, DONE with a status of 0; a
  # `fetch()` rejects with a TypeError. Chrome and Firefox: `ret:1 x-abort:4:0 x-loadend:4:0`, `ret f-rej:TypeError`.
  xhr_log = "const x = new w.XMLHttpRequest(); x.open('GET', '/child?x'); for (const t of ['abort', 'load', 'loadend']) x.addEventListener(t, () => L.push('x-' + t + ':' + x.readyState + ':' + x.status)); x.send();"
  ['f.contentWindow.stop()', 'window.stop()'].each do |stop|
    it "aborts the frame's XHR and fetch() with #{stop}" do
      log = log_of(<<~JS)
        const w = f.contentWindow;
        #{xhr_log}
        w.fetch('/child?y').then(() => L.push('f-ok'), (e) => L.push('f-rej:' + e.name));
        #{stop};
        L.push('ret:' + x.readyState);
      JS
      expect(log).to include('ret:1', 'x-abort:4:0', 'x-loadend:4:0', 'f-rej:TypeError')
      expect(log.join(' ')).not_to include('x-load:')
    end
  end

  # …and by the document's opening where a navigation was under way, and only then: `abort.sub`. Chrome: `x-abort:4:0`.
  it 'aborts the XHR of a document opened with a navigation under way, and only then' do
    log = log_of(<<~JS)
      const w = f.contentWindow;
      #{xhr_log}
      w.location.href = '/child?new';
      w.document.open();
      w.document.close();
    JS
    expect(log).to include('x-abort:4:0')
    log = log_of(<<~JS)
      const w = f.contentWindow;
      #{xhr_log}
      w.document.open();
      w.document.close();
    JS
    expect(log).to include('x-load:4:200')
  end

  # …and its parser's: HTML "abort a parser": what is left of its input thrown away, its readiness `interactive` and `complete`,
  # no `load`, its own or its container's. Chrome and Firefox: `a b` (Chrome `a:loading rs:complete b:complete`, Firefox with
  # `rs:interactive` first, and a DOMContentLoaded: the text has none).
  it 'aborts the parser of a document whose script stops it' do
    log = log_of(<<~'JS')
      f.onload = () => L.push('P-load');
      f.srcdoc = '<script>document.addEventListener("readystatechange", () => top.L.push(document.readyState)); addEventListener("DOMContentLoaded", () => top.L.push("dcl")); top.L.push("a"); stop(); top.L.push("b:" + document.readyState);<\/script><p>a</p><script>top.L.push("c")<\/script>';
    JS
    expect(log.drop_while {|e| e != 'a' }).to eq(%w[a interactive complete b:complete])
  end

  def page_log(body)
    s = session('/' => <<~HTML, '/d.js' => "L.push('defer-ran')", '/a.js' => "L.push('async-ran')")
      <title>x</title><pre id="out"></pre><script>
        const L = window.L = [];
        function done() {
          let o = document.getElementById('out');
          if (!o) { o = document.createElement('pre'); o.id = 'out'; document.documentElement.append(o); }
          o.textContent = L.join(' ');
          document.title = 'done';
        }
        setTimeout(done, 300);
      </script>#{body}
    HTML
    s.visit '/'
    expect(s).to have_title('done', wait: 10)
    s.find('#out', visible: :all).text(:all).split(' ')
  end

  # …the page's, which a poll of its readiness sees `complete`: Chrome and Firefox `t:complete:false`.
  it "aborts the page's parser with its stop()" do
    log = page_log(<<~HTML)
      <script>
        stop();
        L.push('b:' + document.readyState);
        setTimeout(() => L.push('t:' + document.readyState + ':' + !!document.getElementById('after')), 100);
        addEventListener('load', () => L.push('load'));
      </script><h1 id="after">after</h1><script>L.push('script-after')</script>
    HTML
    expect(log).to eq(%w[b:complete t:complete:false])
  end

  # HTML's document open and write steps return where the active parser was aborted. Chrome and Firefox: `openret:true`, the
  # document kept; `write:false later:false:true`.
  it 'refuses a document whose parser was aborted to open() and write()' do
    log = page_log(<<~HTML)
      <script>
        stop();
        document.write('<h2 id="w">w</h2>');
        L.push('write:' + !!document.getElementById('w'));
        setTimeout(() => {
          const r = document.open();
          document.write('<h3 id="z">z</h3>');
          L.push('later:' + (r === document) + ':' + !!document.getElementById('z') + ':' + !!document.getElementById('out'));
        }, 50);
      </script>
    HTML
    expect(log).to eq(%w[write:false later:true:false:true])
  end

  # Its `defer` and `async` scripts cancelled: Chrome and Firefox run neither (Firefox fires DOMContentLoaded: the text has none).
  it "runs no defer or async script of a document stopped as it parses" do
    log = page_log(<<~HTML)
      <script defer src="/d.js"></script><script async src="/a.js"></script>
      <script>addEventListener('DOMContentLoaded', () => L.push('dcl')); addEventListener('load', () => L.push('load')); stop(); L.push('stopped')</script>
    HTML
    expect(log).to eq(%w[stopped])
  end

  # A `stop()` in a DOMContentLoaded handler aborts what "the end" has left: Chrome and Firefox `stopped:complete ierr`, no
  # `load`. The image's fetch, begun in that task, goes on (`imageFetchesStop`), to its `error`: its response is no image.
  it 'stops the load of a document from its DOMContentLoaded handler, an image of that task going on' do
    log = page_log(<<~HTML)
      <script>
        addEventListener('load', () => L.push('load'));
        addEventListener('DOMContentLoaded', () => {
          const i = new Image();
          i.src = '/d.js';
          i.onerror = () => L.push('ierr');
          i.onload = () => L.push('iload');
          document.body.append(i);
          stop();
          L.push('stopped:' + document.readyState);
        });
      </script>
    HTML
    expect(log).to eq(%w[stopped:complete ierr])
  end

  # An image of the task of the frame's `stop()` goes on, to its `error`: its response is no image. Chrome and Firefox: `c:false
  # ie c2:true`.
  it "leaves an image of the task of the frame's stop() to go on" do
    log = log_of(<<~JS)
      const d = f.contentDocument, i = d.createElement('img');
      i.onload = () => L.push('il');
      i.onerror = () => { L.push('ie'); L.push('c2:' + i.complete); };
      i.src = '/child?img';
      d.body.append(i);
      f.contentWindow.stop();
      L.push('c:' + i.complete);
    JS
    expect(log).to eq(%w[c:false ie c2:true])
  end

  # A navigation planned as a document parses aborts its parser, for good where it makes no document: Chrome and Firefox `c
  # Pload rs:complete:false`, the parse going no further.
  it "leaves a frame's document whose location is a 204 aborted at its script" do
    log = log_of(<<~'JS', attrs: '', pages: {'/a204' => '<script>top.L.push("c"); location.href = "/n204"</script><script>top.L.push("c-after")</script><p id="rest">rest</p>', '/n204' => :no_content})
      f.src = '/a204';
      setTimeout(() => L.push('rs:' + f.contentDocument.readyState + ':' + !!f.contentDocument.getElementById('rest')), 200);
    JS
    expect(log).to eq(%w[c rs:complete:false])
  end

  # A `javascript:` URL's navigation aborts the one under way: HTML "navigate" sets the ongoing navigation before it branches
  # on the scheme (ursm's ruling, spec over browsers). Chrome and Firefox go on with `?b` in all three: `… JS old:ph old:un
  # b:script b:load final:…?b`.
  {
    'a src, a src'           => "f.src = '/child?b'; f.src = 'javascript:void(top.L.push(\"JS\"))';",
    'a src, a location'      => "f.src = '/child?b'; f.contentWindow.location.href = 'javascript:void(top.L.push(\"JS\"))';",
    'a location, a src'      => "f.contentWindow.location.href = '/child?b'; f.src = 'javascript:void(top.L.push(\"JS\"))';"
  }.each do |what, run|
    it "ends a navigation with a javascript: URL's: #{what}" do
      log = log_of(<<~JS)
        #{run}
        setTimeout(() => L.push('final:' + U(f)), 200);
      JS
      expect(log).to include('JS', 'final:child?old')
      expect(log).not_to include('b:script')
    end
  end

  # A traversal cancels a navigation queued with it, in either order: HTML "apply the history step" sets the ongoing navigation
  # to "traversal". Chrome and Firefox: `h+4 s1:?a3:h+4 s2:?a2:h+4 s3:?a:h+4 s4:?old:h+4`.
  it 'goes back past a navigation queued with the traversal, in either order' do
    s = session(
      '/child' => child_log,
      '/'      => <<~HTML
        <title>page</title><iframe id="f" src="/child?old"></iframe><pre id="out"></pre><script>
          window.L = [];
          const f = document.getElementById('f');
          const P = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = () => f.contentWindow.location.search;
          onload = async () => {
            await P(50);
            const h0 = history.length;
            const R = [];
            for (const a of ['a', 'a2', 'a3', 'a4']) { f.src = '/child?' + a; await P(80); }
            f.src = '/child?b'; history.back(); await P(200);
            R.push('s1:' + q() + ':h+' + (history.length - h0));
            f.contentWindow.location.href = '/child?c'; history.back(); await P(200);
            R.push('s2:' + q() + ':h+' + (history.length - h0));
            history.back(); f.src = '/child?d'; await P(200);
            R.push('s3:' + q() + ':h+' + (history.length - h0));
            history.back(); f.contentWindow.location.href = '/child?e'; await P(200);
            R.push('s4:' + q() + ':h+' + (history.length - h0));
            document.getElementById('out').textContent = R.join(' ');
            document.title = 'done';
          };
        </script>
      HTML
    )
    s.visit '/'
    expect(s).to have_title('done', wait: 20)
    expect(s.find('#out', visible: :all).text(:all)).to eq('s1:?a3:h+4 s2:?a2:h+4 s3:?a:h+4 s4:?old:h+4')
  end

  # A data: URL's and a srcdoc's entries are traversed to, both ways, as `history.length` says they are there: the first holds
  # its bytes, the second's markup the entry keeps. Chrome and Firefox land on each (Chrome's srcdoc document with the
  # attribute gone an empty one: HTML's document state keeps its resource).
  {
    "f.srcdoc = '<title>sd</title>'; await P(100); f.removeAttribute('srcdoc');" => 'about:srcdoc:sd,child?old,about:srcdoc:sd,child?c',
    "f.src = 'data:text/html,<title>d</title>'; await P(100);"                  => 'opaque,child?old,opaque,child?c'
  }.each do |first, trail|
    it "traverses to the entry of #{first[/srcdoc|data/]}, both ways" do
      s = session(
        '/child' => child_log,
        '/'      => <<~HTML
          <title>page</title><iframe id="f" src="/child?old"></iframe><pre id="out"></pre><script>
            window.L = [];
            const f = document.getElementById('f');
            const P = (ms) => new Promise((r) => setTimeout(r, ms));
            const at = () => { const d = f.contentDocument; return d ? String(d.URL).replace(/^.*\\//, '') + (d.URL.startsWith('about') ? ':' + d.title : '') : 'opaque'; };
            onload = async () => {
              await P(50);
              #{first}
              f.src = '/child?c'; await P(100);
              const R = [];
              history.back(); await P(100); R.push(at());
              history.back(); await P(100); R.push(at());
              history.forward(); await P(100); R.push(at());
              history.forward(); await P(100); R.push(at());
              document.getElementById('out').textContent = R.join(',');
              document.title = 'done';
            };
          </script>
        HTML
      )
      s.visit '/'
      expect(s).to have_title('done', wait: 20)
      expect(s.find('#out', visible: :all).text(:all)).to eq(trail)
    end
  end

  # A reload at a traversed srcdoc entry loads its markup again, not the `src` attribute. Chrome `reload:about:srcdoc`; its
  # document empty with the attribute gone, as above.
  it 'reloads a traversed srcdoc entry from its markup' do
    s = session(
      '/child' => child_log,
      '/'      => <<~HTML
        <title>page</title><iframe id="f" src="/child?a"></iframe><pre id="out"></pre><script>
          window.L = [];
          const f = document.getElementById('f');
          const P = (ms) => new Promise((r) => setTimeout(r, ms));
          const at = () => f.contentWindow.location.href.replace(/^.*\\//, '') + ':' + f.contentDocument.title;
          onload = async () => {
            await P(50);
            f.removeAttribute('src');
            f.srcdoc = '<title>SD</title>';
            await P(100);
            f.removeAttribute('srcdoc');
            f.src = '/child?b';
            await P(100);
            history.back();
            await P(100);
            const back = at();
            f.contentWindow.location.reload();
            await P(100);
            document.getElementById('out').textContent = back + ' ' + at();
            document.title = 'done';
          };
        </script>
      HTML
    )
    s.visit '/'
    expect(s).to have_title('done', wait: 10)
    expect(s.find('#out', visible: :all).text(:all)).to eq('about:srcdoc:SD about:srcdoc:SD')
  end

  # …and a fragment of a srcdoc entry its traversal keeps. Chrome: `b1:about:srcdoc#h`, `b2:about:srcdoc`.
  it "keeps the fragment of a srcdoc entry on a traversal to it" do
    s = session(
      '/child' => child_log,
      '/'      => <<~HTML
        <title>page</title><iframe id="f" src="/child?a"></iframe><pre id="out"></pre><script>
          window.L = [];
          const f = document.getElementById('f');
          const P = (ms) => new Promise((r) => setTimeout(r, ms));
          const at = () => f.contentWindow.location.href.replace(/^.*\\//, '');
          onload = async () => {
            await P(50);
            f.removeAttribute('src');
            f.srcdoc = '<title>SD</title>';
            await P(100);
            f.contentWindow.location.hash = '#h';
            await P(50);
            f.removeAttribute('srcdoc');
            f.src = '/child?z';
            await P(100);
            const R = [];
            history.back(); await P(100); R.push(at());
            history.back(); await P(100); R.push(at());
            document.getElementById('out').textContent = R.join(' ');
            document.title = 'done';
          };
        </script>
      HTML
    )
    s.visit '/'
    expect(s).to have_title('done', wait: 10)
    expect(s.find('#out', visible: :all).text(:all)).to eq('about:srcdoc#h about:srcdoc')
  end

  # An entered frame goes back to a data: entry, by the driver's `go_back` and by the page's `history.back()`, the scope
  # following it: it reached the network with a data: URL, which raised.
  ['go_back', 'execute_script'].each do |how|
    it "traverses an entered frame to a data: entry by #{how}" do
      s = session('/' => '<iframe id="f" src="/x?0"></iframe>', '/x' => '<h1>X</h1>')
      s.visit '/'
      s.evaluate_script('frames[0].document.title')
      s.execute_script(%(document.getElementById('f').src = 'data:text/html,<h1>DATA</h1>'))
      s.within_frame('f') { expect(s.find('h1').text).to eq('DATA') }
      s.execute_script("document.getElementById('f').src = '/x?2'")
      s.within_frame('f') do
        expect(s.find('h1').text).to eq('X')
        how == 'go_back' ? s.go_back : s.execute_script('history.back()')
        expect(s).to have_css('h1', text: 'DATA')
      end
    end
  end

  # What a frame's aborted requests would deliver is cancelled as `stop()` runs, its abort queued in turn: the tasks already
  # queued keep their order. Chrome `Ft0-before Pt0-before Fx:0 Ft0-after Pt0-after`.
  it "keeps the order of a frame's tasks across its parent's stop()" do
    log = log_of(<<~JS)
      const w = f.contentWindow;
      w.setTimeout(() => L.push('Ft0-before'), 0);
      setTimeout(() => L.push('Pt0-before'), 0);
      const x = new w.XMLHttpRequest();
      x.open('GET', '/child?1');
      x.onloadend = () => L.push('Fx:' + x.status);
      x.send();
      window.stop();
      w.setTimeout(() => L.push('Ft0-after'), 0);
      setTimeout(() => L.push('Pt0-after'), 0);
    JS
    expect(log).to eq(%w[Ft0-before Pt0-before Fx:0 Ft0-after Pt0-after])
  end

  it 'traverses an entered frame to a srcdoc entry, the scope following it' do
    s = session('/' => '<iframe id="f" srcdoc="<p id=at>first</p>"></iframe>', '/b' => '<p id="at">b</p>')
    s.visit '/'
    s.within_frame('f') { expect(s.find('#at').text).to eq('first') }
    s.execute_script("const f = document.getElementById('f'); f.removeAttribute('srcdoc'); f.src = '/b'")
    s.within_frame('f') do
      expect(s.find('#at').text).to eq('b')
      s.execute_script('history.back()')
      expect(s).to have_css('#at', text: 'first')
    end
  end

  # The driver's own wait: a frame entered right after its `src` is set is at the next document.
  it 'enters the document a queued src navigation goes to' do
    s = session('/' => '<iframe id="f" src="/a"></iframe>', '/a' => '<p id="at">a</p>', '/b' => '<p id="at">b</p>')
    s.visit '/'
    s.within_frame('f') { expect(s.find('#at').text).to eq('a') }
    s.execute_script("document.getElementById('f').src = '/b'")
    s.within_frame('f') { expect(s.find('#at').text).to eq('b') }
  end

  # `stop()` against a server that takes its time: a `/slow/<ms>/<name>` answers after that long, the event loop going on
  # meanwhile as the virtual clock moves (the app's `sleep`). Each page as Chrome 157 and Firefox 159 ran it (rvfn `k*_`,
  # `h_*`, `m_*`, `z3_*`, 2026-11-06). They fire a parent's `load` inside the `stop()` that ended what delayed it, where HTML
  # "the end" queues a task for it ("Queue a global task on the DOM manipulation task source"), and read `complete` there:
  # the explicit text the ruling, so `Pload` comes after the `stop()` here, and a page not aborted reads `interactive` in it.
  describe 'stop() as a server takes its time' do
    SLOW_TYPES = {'js' => 'text/javascript', 'css' => 'text/css', 'png' => 'image/png', 'html' => 'text/html'}.freeze
    REAL_PNG   = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.unpack1('m').freeze

    def slow_session(pages)
      simulated_session(->(env) {
        path = env['PATH_INFO']
        if (m = path.match(%r{\A/slow/(\d+)/(.*)\z}))
          sleep(m[1].to_i / 1000.0)
          type = m[2].split('.').last
          body = {
            'js'   => "(window.L || top.L).push('#{m[2]}-ran')",
            'html' => "<!DOCTYPE html><title>sf</title><script>top.L.push('sf-script'); onload = () => top.L.push('sf-load')</script>",
            'css'  => 'p { color: red }',
            'png'  => m[2].start_with?('real') ? REAL_PNG : 'x'
          }.fetch(type, 'x')
          next [200, {'content-type' => SLOW_TYPES.fetch(type, 'text/plain')}, [body]]
        end
        next [204, {}, []] if path == '/nothing'

        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{pages.fetch(path)}"]]
      })
    end

    PAGE_LOG = <<~HTML
      <title>x</title><pre id="out"></pre><script>
        const L = window.L = [];
        const logged = () => { const o = document.getElementById('out') || document.documentElement.appendChild(document.createElement('pre')); o.id = 'out'; o.textContent = L.join(' '); document.title = 'done'; };
        addEventListener('DOMContentLoaded', () => L.push('dcl'));
        addEventListener('load', () => L.push('load'));
      </script>
    HTML

    # What a page logs by `at` ms, its readiness at the end.
    def page_log(body, at: 400, pages: {})
      s = slow_session(pages.merge('/' => <<~HTML))
        #{PAGE_LOG}<script>setTimeout(() => { L.push('rs:' + document.readyState); logged(); }, #{at});</script>#{body}
      HTML
      s.visit '/'
      expect(s).to have_title('done', wait: 15)
      s.find('#out', visible: :all).text(:all)
    end

    # A page of one frame `f` at `/c`, what comes of it by then.
    def frame_log(child, at: 700, parent: '')
      page_log(<<~HTML, at: at, pages: {'/c' => child})
        <iframe id="f" src="/c"></iframe><script>
          f = document.getElementById('f');
          f.onload = () => L.push('Fload');
          #{parent}
        </script>
      HTML
    end

    CHILD_LOAD = "<title>c</title><script>addEventListener('load', () => top.L.push('cload'))</script>"
    CHILD_STOP = "<script>setTimeout(() => { stop(); top.L.push('cstop:' + document.readyState); }, 0)</script>"

    # HTML "abort a document": an aborted document's load never fires, and so delays its parent's no more.
    it "fires its parent's load after a frame's stop() cancels its image" do
      log = frame_log("#{CHILD_LOAD}<img src=\"/slow/60/i.png\">#{CHILD_STOP}")
      # Chrome and Firefox: dcl Pload cstop:complete, the load inside the stop()
      expect(log).to eq('dcl cstop:complete load rs:complete')
    end

    it "fires its parent's load with another frame's in it fired before" do
      log = page_log(<<~HTML, at: 700, pages: {'/c' => "#{CHILD_LOAD}<img src=\"/slow/200/i.png\">#{CHILD_STOP}", '/g' => '<title>g</title>'})
        <iframe id="f" src="/c"></iframe><iframe id="g" src="/g"></iframe><script>
          document.getElementById('g').onload = () => L.push('Gload');
        </script>
      HTML
      # Chrome and Firefox: dcl Gload load cstop:complete
      expect(log).to eq('dcl cstop:complete Gload load rs:complete').or eq('dcl Gload cstop:complete load rs:complete')
    end

    it "fires the page's load after its own stop() ends what only its frame delayed" do
      log = frame_log(
        "#{CHILD_LOAD}<img src=\"/slow/300/i.png\"><script>setTimeout(() => { stop(); top.L.push('cstop:' + document.readyState); }, 50)</script>",
        parent: "setTimeout(() => { stop(); L.push('stopped'); }, 30);"
      )
      # Chrome and Firefox: dcl load stopped cstop:complete, the frame's abort in the stop(), and no cload, no Fload
      expect(log).to eq('dcl stopped load cstop:complete rs:complete')
    end

    it "fires no load of a page with an image of its own after its stop(), a frame in it or not" do
      log = page_log(<<~HTML, pages: {'/g' => '<title>g</title>'})
        <iframe src="/g"></iframe><img src="/slow/300/i.png"><script>addEventListener('DOMContentLoaded', () => { stop(); L.push('stopped'); });</script>
      HTML
      expect(log).to eq('dcl stopped rs:complete')
    end

    it "fires no load of a page aborted with its load waiting on a frame's server" do
      log = page_log(<<~HTML)
        <iframe src="/slow/100/f.html"></iframe><img src="/slow/300/i.png"><script>setTimeout(() => { stop(); L.push('stopped'); }, 20)</script>
      HTML
      expect(log).to eq('dcl stopped rs:complete')
    end

    # HTML "abort a parser": "Throw away any pending content in the input stream, and discard any future content".
    {
      "a custom element's constructor" => [
        "<script>customElements.define('x-s', class extends HTMLElement { constructor() { super(); stop(); L.push('ce'); } })</script><x-s></x-s>",
        'ce'
      ],
      "a frame's load fired as it is inserted" => ["<iframe onload=\"stop(); L.push('ifrl')\"></iframe>", 'ifrl'],
      'a script a `document.write` wrote' => [
        %(<script>document.write('<script>stop(); document.write("<script>L.push(1)<\\\\/script>"); L.push("w2")<\\/script><script>L.push("dw-after")<\\/script>')</script>),
        'w2'
      ]
    }.each do |what, (markup, logged)|
      it "goes no further than #{what} that stopped the parser" do
        log = page_log("#{markup}<p id=\"after\">after</p><script>L.push('after-script')</script>")
        expect(log).to eq("#{logged} rs:complete")
      end
    end

    # HTML "abort a document": "Cancel any instances of the fetch algorithm… discarding any tasks queued for them".
    {
      'a deferred script' => ['<script defer src="/slow/120/s.js"></script>', 'after-script stopped rs:complete'],
      'an `async` script' => ['<script async src="/slow/120/s.js"></script>', 'after-script dcl stopped rs:complete'],
      'a module script'   => ['<script type="module" src="/slow/120/s.js"></script>', 'after-script stopped rs:complete']
    }.each do |what, (markup, logged)|
      it "runs no #{what.sub(/\Aa(n)? /, '')} whose fetch a stop() cancelled" do
        log = page_log("#{markup}<script>setTimeout(() => { stop(); L.push('stopped'); }, 0)</script><script>L.push('after-script')</script>")
        expect(log).to eq(logged)
      end
    end

    it 'runs no parser-blocking script whose fetch a stop() cancelled, and goes no further' do
      log = page_log("<script>setTimeout(() => { stop(); L.push('stopped'); }, 0)</script><script src=\"/slow/120/s.js\"></script><script>L.push('after-script')</script>")
      expect(log).to eq('stopped rs:complete')
    end

    it 'runs no script a script inserted, stop() in the same task (Chrome its `error`, Firefox none)' do
      log = page_log(<<~HTML)
        <script>
          const s = document.createElement('script');
          s.src = '/slow/20/s.js';
          s.onload = () => L.push('sl');
          s.onerror = () => L.push('se');
          document.head.append(s);
          stop();
        </script>
      HTML
      expect(log).to eq('rs:complete')
    end

    # DOMContentLoaded waits for the list of scripts to execute after parsing, which an `async` one is not on. Its fetch takes
    # no time here, so it has landed where its parser has had to wait on a fetch, and not otherwise (`landAsyncScripts`): each
    # as Chrome and Firefox agree where they do (rvfn `d_*`, `l_*`, `e_mix*`), at Firefox's place where they part.
    {
      'alone'                                 => ['<script async src="/slow/0/s.js"></script><p>x</p>', 'dcl s.js-ran load rs:complete'],
      'two of them'                           => ['<script async src="/slow/0/a.js"></script><script async src="/slow/0/b.js"></script>', 'dcl a.js-ran b.js-ran load rs:complete'],
      'an inline script after it'             => ["<script async src=\"/slow/0/s.js\"></script><script>L.push('inl')</script>", 'inl dcl s.js-ran load rs:complete'],
      'a parser-blocking script after it'     => ['<script async src="/slow/0/a.js"></script><script src="/slow/0/b.js"></script>', 'b.js-ran a.js-ran dcl load rs:complete'],
      'a parser-blocking script, a slow one'  => ['<script async src="/slow/0/a.js"></script><script src="/slow/50/b.js"></script>', 'b.js-ran a.js-ran dcl load rs:complete'],
      'a deferred script after it'            => ['<script async src="/slow/0/a.js"></script><script defer src="/slow/50/d.js"></script>', 'a.js-ran d.js-ran dcl load rs:complete'],
      'a sheet that blocks a script'          => [
        "<script async src=\"/slow/0/a.js\"></script><link rel=\"stylesheet\" href=\"/slow/0/s.css\"><script>L.push('inl')</script><script async src=\"/slow/0/b.js\"></script>",
        'inl a.js-ran b.js-ran dcl load rs:complete'
      ],
      'a mix of everything'                   => [
        %(<script async src="/slow/0/a1.js"></script><script defer src="/slow/0/d1.js"></script><script src="/slow/0/b1.js"></script><script async src="/slow/0/a2.js"></script><script defer src="/slow/0/d2.js"></script>),
        'b1.js-ran a1.js-ran a2.js-ran d1.js-ran d2.js-ran dcl load rs:complete'
      ]
    }.each do |what, (markup, logged)|
      it "runs an `async` script as Chrome and Firefox do, #{what}" do
        expect(page_log(markup)).to eq(logged)
      end
    end

    it 'hears DOMContentLoaded from a listener an `async` script adds, a parser-blocking script after it' do
      log = page_log(<<~HTML)
        <script async src="data:text/javascript,document.addEventListener('DOMContentLoaded',()=>L.push('late'));L.push('reg')"></script><script src="/slow/0/b.js"></script>
      HTML
      expect(log).to eq('b.js-ran reg late dcl load rs:complete')
    end

    # HTML "the end": "Spin the event loop until the set of scripts that will execute as soon as possible and the list of
    # scripts that will execute in order as soon as possible are empty", then the load's task. Its server's `sleep` runs the
    # event loop inside the fetch.
    it 'fires no load before an `async` script a server takes its time over' do
      log = page_log(%(<script async src="/slow/100/s.js"></script><script>L.push('inl')</script>))
      expect(log).to eq('inl dcl s.js-ran load rs:complete')
    end

    it 'fires no load before the slower of two `async` scripts' do
      log = page_log('<script async src="/slow/100/a.js"></script><script async src="/slow/10/b.js"></script>', at: 600)
      expect(log).to eq('dcl b.js-ran a.js-ran load rs:complete')
    end

    it 'fires no load of a page with a frame before an `async` script stopped as its server took its time' do
      log = page_log('<script async src="/slow/200/s.js"></script><iframe src="/g"></iframe><script>setTimeout(() => { stop(); L.push("stopped"); }, 60)</script>', pages: {'/g' => '<title>g</title>'})
      expect(log).to eq('dcl stopped rs:complete')
    end

    it 'runs a script against the sheets before it, whatever connected them' do
      log = page_log(<<~HTML, pages: {'/g' => '<title>g</title>'})
        <link rel="stylesheet" href="/slow/100/s.css"><iframe src="/g"></iframe><script>setTimeout(() => { stop(); L.push('stopped'); }, 30)</script>
      HTML
      expect(log).to eq('dcl load stopped rs:complete')
    end

    it "cancels an `async` script's fetch with a stop() in a DOMContentLoaded handler" do
      log = page_log('<script async src="/slow/0/s.js"></script><script>addEventListener("DOMContentLoaded", () => stop())</script>')
      expect(log).to eq('dcl rs:complete')
    end

    it 'leaves a srcdoc frame not built yet at its initial about:blank with the parser stopped' do
      log = page_log(<<~HTML, at: 300, pages: {'/g' => '<title>g</title>'})
        <iframe id="f" srcdoc="<title>sd</title><img src=/slow/100/i.png>"></iframe><script>
          f = document.getElementById('f');
          stop();
          L.push(f.contentWindow.location.href);
          setTimeout(() => L.push(f.contentWindow.location.href + ':' + f.contentDocument.readyState), 200);
        </script>
      HTML
      expect(log).to eq('about:blank about:blank:complete rs:complete')
    end

    it "drops a frame's response a stop() cancelled as it was fetched" do
      log = page_log(<<~HTML, at: 300)
        <iframe id="g" src="/slow/100/f.html"></iframe><script>
          g = document.getElementById('g');
          g.onload = () => L.push('Gload');
          setTimeout(() => { stop(); L.push('stopped'); }, 20);
          setTimeout(() => L.push(g.contentWindow.location.href), 200);
        </script>
      HTML
      # Chrome and Firefox: dcl load stopped about:blank
      expect(log).to eq('dcl stopped load about:blank rs:complete')
    end

    it 'navigates a frame again as the response of its last navigation is fetched' do
      log = page_log(<<~HTML, at: 500)
        <iframe id="f" src="/slow/100/a.html"></iframe><script>
          f = document.getElementById('f');
          f.onload = () => L.push('fl:' + f.contentWindow.location.href.split('/').pop());
          setTimeout(() => { f.src = '/slow/10/b.html'; }, 20);
        </script>
      HTML
      expect(log).to eq('dcl sf-script sf-load fl:b.html load rs:complete')
    end

    # The container's load: none for a document aborted, whatever else it has waiting; after its document's for one not.
    {
      'a style sheet'     => '<link rel="stylesheet" href="/slow/60/s.css">',
      'a deferred script' => '<script defer src="/slow/60/s.js"></script>'
    }.each do |what, markup|
      it "fires no container load for a frame stopped as it parsed with #{what} pending" do
        expect(frame_log("#{CHILD_LOAD}#{markup}<script>stop()</script>")).to eq('dcl load rs:complete')
      end
      it "fires no container load for a frame stopped in its DOMContentLoaded with #{what} on it" do
        log = frame_log("#{CHILD_LOAD}#{markup}<script>addEventListener('DOMContentLoaded', () => stop())</script>")
        expect(log).not_to include('Fload')
      end
    end

    it "fires a frame's container load after its document's, its build waiting on its server" do
      log = frame_log("#{CHILD_LOAD}<link rel=\"stylesheet\" href=\"/slow/100/s.css\">")
      expect(log).to eq('dcl cload Fload load rs:complete')
    end

    # HTML "navigate": a page's own, as a frame's, aborts the parser that planned it.
    it "aborts the page's parser with a location set as it parses, which makes no document" do
      log = page_log(<<~HTML)
        <script>location.href = '/nothing'; L.push('set');</script><p id="z">z</p><script>L.push('after')</script>
      HTML
      # Chrome and Firefox: set rs:complete
      expect(log).to eq('set rs:complete')
    end

    # HTML cancels the fetch "discarding any tasks queued for them": no event, as Firefox has it, where Chrome fires `error`.
    # But an image whose stable state had not come as the `stop()` ran has no fetch yet to cancel ("update the image data"
    # awaits it): it goes on, its `load` or, an image that is none, its `error`, which Chrome and Firefox agree on (rvfn
    # `x_real_*`, `m_*_sync`).
    IMAGE_ENDS = "i.onerror = () => { L.push('E'); logged(); }; i.onload = () => { L.push('I:' + i.naturalWidth); logged(); };"
    {
      'its `src` set in that task'      => "const i = new Image(); i.src = '/slow/50/%s'; #{IMAGE_ENDS} stop();",
      'it inserted in that task'        => "document.body.insertAdjacentHTML('beforeend', '<img id=i src=/slow/50/%s>'); const i = document.getElementById('i'); #{IMAGE_ENDS} stop();"
    }.each do |what, script|
      {'real.png' => 'I:1', 'x.png' => 'E'}.each do |image, logged|
        it "leaves #{image}'s fetch to go on with `stop()`, #{what}" do
          log = page_log("<body><script>onload = () => setTimeout(() => { #{format(script, image)} }, 10)</script>", at: 60_000)
          expect(log).to eq("dcl load #{logged}")
        end
      end
    end

    it "leaves the fetch of an image a parser-run script's `document.write` wrote to go on, with its `stop()`" do
      log = page_log(<<~HTML, at: 60_000)
        <script>document.write('<img id="i" src="/slow/50/real.png">'); const i = document.getElementById('i'); #{IMAGE_ENDS} stop();</script>
      HTML
      expect(log).to eq('I:1')
    end

    {
      'its `src` set a task before'                 => "const i = new Image(); i.src = '/slow/200/real.png'; #{IMAGE_ENDS} setTimeout(() => stop(), 0);",
      'its `src` set before a microtask checkpoint' => "(async () => { const i = new Image(); i.src = '/slow/200/real.png'; #{IMAGE_ENDS} await 0; stop(); })();"
    }.each do |what, script|
      it "cancels an image's fetch with `stop()`, no event, #{what}" do
        log = page_log(<<~HTML)
          <body><script>onload = () => setTimeout(() => { #{script} }, 10)</script>
        HTML
        expect(log).to eq('dcl load rs:complete')
      end
    end

    it 'makes an image complete whose fetch `stop()` cancelled, with no event' do
      log = page_log(<<~HTML)
        <body><script>onload = () => setTimeout(() => {
          const i = new Image();
          i.src = '/slow/200/real.png';
          #{IMAGE_ENDS}
          setTimeout(() => stop(), 0);
          setTimeout(() => L.push('c' + i.complete), 100);
        }, 10)</script>
      HTML
      expect(log).to eq('dcl load ctrue rs:complete')
    end

    it "fires no `error` at a parsed image for the stop() of a later script" do
      log = page_log(<<~HTML)
        <img id="i" src="/slow/200/real.png"><script>const i = document.getElementById('i'); #{IMAGE_ENDS} setTimeout(() => L.push('c' + i.complete), 100); stop();</script>
      HTML
      expect(log).to eq('ctrue rs:complete')
    end

    it 'rejects the decodes waiting on an image a stop() cancelled, with no `error`' do
      log = page_log(<<~HTML)
        <script>onload = () => setTimeout(() => {
          const i = new Image();
          i.onerror = () => L.push('E');
          i.src = '/slow/200/i.png';
          i.decode().then(() => L.push('decoded'), () => L.push('rejected'));
          setTimeout(() => stop(), 10);
        }, 10)</script>
      HTML
      expect(log).to eq('dcl load rejected rs:complete')
    end
  end
end
