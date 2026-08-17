require 'capybara/simulated'
require 'rack'
require_relative 'support/js_engine'
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

  # `history.back()` is the third same-document mutator (`history_go`), and unlike
  # the other two it moves the history INDEX. Queued by the page being left — here
  # stepping back inside its own pushState chain, which is the branch that takes
  # effect INLINE — it would move the index out from under the navigation that is
  # committing, and the entry list would then be truncated at the wrong point: the
  # `/three` we left from disappears. The traversal the driver was asked for wins and
  # the page's own is dropped. Chrome resolves this race the other way (measured,
  # 151: a `back()` during an in-flight navigation cancels that navigation and
  # traverses), but a `visit` that silently doesn't happen is the worse failure for a
  # test driver. The `flushed` beacon is what proves the outgoing timer ran at all.
  it "drops a history.back() the outgoing page queued inside its own pushState chain" do
    app = lambda do |env|
      body =
        if env['PATH_INFO'] == '/one'
          <<~HTML
            <html><body><p id='here'>/one</p>
              <script>
                history.pushState({}, '', '/two');
                history.pushState({}, '', '/three');
                setTimeout(() => { localStorage.setItem('flushed', '1'); history.back(); }, 0);
              </script>
            </body></html>
          HTML
        else
          "<html><body><p id='here'>#{env['PATH_INFO']}</p></body></html>"
        end
      [200, {'content-type' => 'text/html'}, [body]]
    end
    s = simulated_session(app)
    s.visit '/one'
    s.visit '/far'

    expect(s.evaluate_script("localStorage.getItem('flushed')")).to eq('1')
    expect(s.find('#here').text).to eq('/far')
    expect(s.current_url).to end_with('/far')

    # The entry we left from is still the one before this navigation.
    s.go_back
    expect(s.current_url).to end_with('/three')
  end

  context 'inside a nested browsing context' do
    before { skip 'per-frame realms need the V8 engine' unless CsimEngine.v8? }

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
