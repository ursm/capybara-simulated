# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "navigate" runs a few steps at once and the rest in parallel with the event loop: its document asked whether it
# may be unloaded (a queued task, "checking if unloading is canceled" step 7), its response fetched, that document unloaded
# and the next one made ("attempt to populate the history entry's document", "finalize a cross-document navigation"). So
# what is due before all that runs first, and the frame's document and window are the old ones until then: here, a task
# of the agent's event loop behind every other due at its instant (timers.rs `BEHIND`). Each page below as Chrome 156 and
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

  # The driver's own wait: a frame entered right after its `src` is set is at the next document.
  it 'enters the document a queued src navigation goes to' do
    s = session('/' => '<iframe id="f" src="/a"></iframe>', '/a' => '<p id="at">a</p>', '/b' => '<p id="at">b</p>')
    s.visit '/'
    s.within_frame('f') { expect(s.find('#at').text).to eq('a') }
    s.execute_script("document.getElementById('f').src = '/b'")
    s.within_frame('f') { expect(s.find('#at').text).to eq('b') }
  end
end
