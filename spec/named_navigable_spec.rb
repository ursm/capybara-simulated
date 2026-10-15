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

  PAGES = {
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
      body = PAGES[env['PATH_INFO']] || "<p id=\"p\">#{env['PATH_INFO']}</p>"
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
  # navigation, which its click handler started, has replaced it — under the policy its `rel` / `referrerpolicy` sets.
  it "sends the Referer of the document the link was followed in, under the link's policy" do
    s, log = session_for(
      '/p' => '<a id="nr" href="/x1" target="b" rel="noreferrer">n</a> <a id="or" href="/x2" target="b" referrerpolicy="origin">o</a>' \
              '<iframe name="a" src="/a"></iframe><iframe name="b" src="/b"></iframe>',
      '/a' => %(<a id="go" href="/x" target="b" onclick="location.href='/self'">go</a>)
    )
    s.execute_script('frames[0].document.getElementById("go").click()')
    expect(poll_until { s.evaluate_script('frames[1].location.pathname').then {|v| v if v == '/x' } }).to eq('/x')
    s.find('#nr').click
    s.find('#or').click
    expect(log.select {|path,| %w[/x /x1 /x2].include?(path) }).to eq([['/x', 'http://www.example.com/a'], ['/x1', nil], ['/x2', 'http://www.example.com/']])
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
end
