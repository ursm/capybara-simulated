require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Same-document navigation: a fragment change (`location.hash = …`, an in-page anchor) and
# `history.pushState` / `replaceState`. Two contracts that only show up once you look past the
# top document — WHEN `hashchange` fires, and WHOSE session history a nested context writes to.
RSpec.describe 'same-document navigation' do
  def session(frame_body: '<script></script>')
    app = lambda do |env|
      case env['PATH_INFO']
      when '/frame.html' then [200, {'content-type' => 'text/html'}, [frame_body]]
      else [200, {'content-type' => 'text/html'}, ['<html><body><iframe id="f" src="/frame.html?step=1"></iframe></body></html>']]
      end
    end
    simulated_session(app).tap {|s| s.visit '/' }
  end

  def poll(session, expr)
    poll_until { session.evaluate_script(expr) }
  end

  # HTML fires `hashchange` while applying the history step — after the script that navigated has
  # run to completion — so a listener registered on the NEXT line still receives it. Measured in
  # Chrome 137: `location.hash = 'frag'; addEventListener('hashchange', …)` fires, and before a
  # co-queued setTimeout. Firing it inline would deliver it to nobody in the assign-then-await
  # shape (`location.href = '#f'; await waitFor(window, 'hashchange')`) that every navigation
  # helper is written in. `location.href` itself updates synchronously, as it does in Chrome.
  it 'fires hashchange from a queued task, not during the assignment' do
    s = session
    s.execute_script(<<~JS)
      globalThis.__log = [];
      location.hash = 'frag';
      globalThis.__log.push('assigned=' + location.hash);
      window.addEventListener('hashchange', e => globalThis.__log.push('hashchange=' + new URL(e.newURL).hash));
      setTimeout(() => globalThis.__log.push('timer'), 50);
    JS
    poll(s, "globalThis.__log.includes('timer')")

    expect(s.evaluate_script('globalThis.__log')).to eq(['assigned=#frag', 'hashchange=#frag', 'timer'])
  end

  # HTML "navigate": a navigation to a fragment is one to a URL WITH a fragment — `#` too — equal to the document's but
  # for their fragments (url_ops.rs `is_fragment_navigation`). Measured in Chrome 151 (2026-10-15): `location.href =
  # '#x'` at `#x` neither loads nor fires `hashchange`; `location.hash = ''` lands on `…#` and fires it; `location.href
  # = location.href` there does not load; `/a#` → `/a` loads the document again.
  it 'tells a navigation to a fragment by the URL it navigates to' do
    loads = 0
    app = lambda do |_env|
      loads += 1
      [200, {'content-type' => 'text/html'}, ['<html><body><script>window.hc = []; addEventListener("hashchange", e => hc.push(e.newURL))</script></body></html>']]
    end
    s = simulated_session(app)
    s.visit '/a#x'
    step = lambda do |js|
      s.execute_script(js)
      s.execute_script('setTimeout(() => { window.settled = true }, 20)')
      poll_until { s.evaluate_script('window.settled === true') }
      s.execute_script('window.settled = false')
      [loads, s.evaluate_script('location.href').sub(%r{\Ahttp://[^/]+}, ''), s.evaluate_script('hc.length')]
    end

    expect(step.("location.href = '#x'")).to eq([1, '/a#x', 0])
    expect(step.("location.hash = ''")).to eq([1, '/a#', 1])
    expect(step.('location.href = location.href')).to eq([1, '/a#', 1])
    expect(step.("location.href = '/a'")).to eq([2, '/a', 0])
  end

  # HTML "shared history push/replace state steps": the state is SERIALIZED (history.state a copy, a DataCloneError for
  # what cannot be), the URL parsed against the document's BASE URL and refused (a SecurityError) where the document
  # cannot have its URL rewritten to it (url_ops.rs `can_rewrite`). Measured in Chrome 151 (2026-10-15) on a page with
  # `<base href="/sub/">`: pushState(o, '', 'x') lands on /sub/x with `history.state !== o`; a function state throws
  # DataCloneError; a cross-origin URL throws SecurityError; `history` is a History.
  it 'serializes the state and checks the URL pushState is given' do
    app = ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><base href="/sub/"><body></body>']] }
    s = simulated_session(app)
    s.visit '/h'
    out = s.evaluate_script(<<~JS)
      (() => {
        const out = {};
        const o = {a: 1};
        history.pushState(o, '', 'x');
        out.copy = history.state !== o && history.state.a === 1 && history.state === history.state;
        out.path = location.pathname;
        try { history.pushState(() => 1, ''); out.fn = 'none'; } catch (e) { out.fn = e.name; }
        try { history.replaceState(null, '', 'https://example.org/'); out.xo = 'none'; } catch (e) { out.xo = e.name; }
        out.history = Object.getPrototypeOf(history) === History.prototype;
        return out;
      })()
    JS

    expect(out).to eq('copy' => true, 'path' => '/sub/x', 'fn' => 'DataCloneError', 'xo' => 'SecurityError', 'history' => true)
  end

  # The rest of the steps around it (HTML "shared history push/replace state steps", "navigate to a fragment", "update
  # document for history step application"): an EMPTY url keeps the document's URL, fragment and all (Chrome 151 —
  # under a `<base>` too, and in an about:srcdoc frame, where resolving it would have refused it); a navigation to a
  # fragment makes an entry with no state (`history.state` null after `pushState({a: 1}); location.hash = 'y'`, Chrome);
  # a reload restores the entry's state; a top-level document's `_top` / `_parent` link is a link to itself; and a
  # `#z` link under `<base href="/sub/">` goes to /sub/ — another document.
  it 'keeps the URL an empty one names, and the state a reload restores' do
    app = lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><base href="/sub/"><a id="t" href="/a#top" target="_top">t</a><a id="b" href="#z">b</a><script>window.hc = 0; addEventListener("hashchange", () => hc++)</script>']]
    end
    s = simulated_session(app)
    s.visit '/a#x'
    s.execute_script("history.pushState({k: 1}, '', '')")
    expect(s.evaluate_script('[location.pathname + location.hash, history.state.k]')).to eq(['/a#x', 1])
    s.execute_script("location.hash = 'y'")
    expect(s.evaluate_script('history.state')).to be_nil
    s.execute_script("history.replaceState({k: 2}, '')")
    s.refresh
    expect(s.evaluate_script('history.state')).to eq('k' => 2)
    s.find(:css, '#t').click
    poll_until { s.evaluate_script('hc') == 1 }
    expect(s.evaluate_script('location.pathname + location.hash')).to eq('/a#top')
    s.find(:css, '#b').click
    expect(s.evaluate_script('location.pathname + location.hash')).to eq('/sub/#z')
  end

  # The document being navigated away from keeps running until the new response
  # COMMITS, so a `replaceState` / `pushState` it had queued is real — it rewrites
  # and appends ITS OWN entries — but it cannot move the incoming document's URL.
  # Measured in Chrome 151 (`/arrived` served slowly, the outgoing page's timers
  # firing while it is in flight): the new page loads at `/arrived`, and going back
  # from it lands on `/pushed`. The driver runs the outgoing page's due-now work in
  # `flush_outgoing_page_init`; doing that AFTER the commit is what let Mastodon's
  # post-sign-in `<Redirect to='/home'>` rewrite the URL of the profile page a
  # `visit` had just loaded, which then rendered the home timeline instead.
  it "keeps the outgoing page's replaceState and pushState off the incoming page's URL" do
    app = lambda do |env|
      body =
        case env['PATH_INFO']
        when '/leaving'
          <<~HTML
            <html><body>leaving
              <script>
                setTimeout(() => { history.replaceState({}, '', '/replaced'); }, 0);
                setTimeout(() => { history.pushState({}, '', '/pushed'); }, 0);
              </script>
            </body></html>
          HTML
        else
          "<html><body><p id='here'>#{env['PATH_INFO']}</p></body></html>"
        end
      [200, {'content-type' => 'text/html'}, [body]]
    end
    s = simulated_session(app)
    s.visit '/leaving'
    s.visit '/arrived'

    # Read twice: the first read drains the URL-transition queue, so a stale
    # transition queued by the outgoing page would only surface on the second.
    expect(s.current_url).to end_with('/arrived')
    expect(s.current_url).to end_with('/arrived')
    expect(s.evaluate_script('location.pathname')).to eq('/arrived')
    expect(s.find('#here').text).to eq('/arrived')

    # The outgoing document's own entries stand: back lands on what it pushed.
    s.go_back
    expect(s.current_url).to end_with('/pushed')
    expect(s.evaluate_script('location.pathname')).to eq('/pushed')
  end

  context 'inside a nested browsing context' do
    it 'fires hashchange in the frame that navigated' do
      s = session(frame_body: <<~HTML)
        <script>
          window.addEventListener('message', () => {
            location.href = '#fragment';
            parent.postMessage('assigned=' + location.hash);
            window.addEventListener('hashchange', () => parent.postMessage('hashchange'));
          });
        </script>
      HTML
      s.execute_script(<<~JS)
        globalThis.__log = [];
        window.addEventListener('message', e => globalThis.__log.push(String(e.data)));
        document.getElementById('f').contentWindow.postMessage('go');
      JS
      poll(s, "globalThis.__log.includes('hashchange')")

      expect(s.evaluate_script('globalThis.__log')).to eq(['assigned=#fragment', 'hashchange'])
    end

    # A nested context's session history is its OWN. Mirroring a frame's pushState onto the top
    # document's made `current_url` report a URL no window was ever at — the shape any iframe'd
    # SPA produces on every navigation.
    it 'leaves the top document out of a frame pushState' do
      s = session
      s.execute_script("document.getElementById('f').contentWindow.history.pushState({}, '', '?step=2');")

      expect(s.evaluate_script("document.getElementById('f').contentWindow.location.href")).to end_with('/frame.html?step=2')
      expect(s.evaluate_script('location.href')).to eq('http://www.example.com/')
      expect(s.current_url).to eq('http://www.example.com/')
    end

    # `location.reload()` reloads the document's CURRENT url, which pushState changed — not the
    # `src` the iframe was built from.
    it 'reloads the pushState url rather than the frame src' do
      s = session(frame_body: '<script>parent.postMessage("loaded=" + location.search);</script>')
      s.execute_script(<<~JS)
        globalThis.__log = [];
        window.addEventListener('message', e => globalThis.__log.push(String(e.data)));
        const w = document.getElementById('f').contentWindow;
        w.history.pushState({}, '', '?step=2');
        w.location.reload();
      JS
      poll(s, "globalThis.__log.length > 0")

      expect(s.evaluate_script('globalThis.__log')).to eq(['loaded=?step=2'])
      expect(s.evaluate_script("document.getElementById('f').contentWindow.location.href")).to end_with('/frame.html?step=2')
    end
  end
end
