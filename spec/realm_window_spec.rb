require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A window `window.open` made in its opener's isolate (RealmWindow) is a window of the session like any other: Capybara
# switches to it, finds, clicks, fills, evaluates, reads its URL and title, navigates it, resizes it, paints it and
# closes it — its documents' realms addressed in their host, its opener's page left as it is.
RSpec.describe 'a window made in its opener\'s isolate' do
  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
      when '/'
        <<~HTML
          <!doctype html><html><head><meta charset="utf-8"><title>main</title></head><body>
            <h1 id="main">MAIN</h1>
            <button id="open" onclick="openBlank()">open</button>
            <script>
              function openBlank() {
                window.popup = window.open();
                window.popup.document.write(
                  '<!doctype html><title>blank</title><body><p id="in">IN</p>' +
                  '<input id="field"><button id="b" onclick="document.title = \\'clicked:\\' + document.getElementById(\\'field\\').value">b</button>' +
                  '<a id="next" href="/second">next</a>' +
                  '<iframe id="fr" srcdoc="<p id=deep>DEEP</p>"></iframe></body>'
                );
                window.popup.document.close();
              }
            </script>
          </body></html>
        HTML
      when '/second'
        '<!doctype html><html><head><meta charset="utf-8"><title>second</title></head><body><p id="second">SECOND</p></body></html>'
      when '/boom'
        raise 'boom'
      when '/r307'
        return [307, {'location' => '/posted'}, []]
      when '/missing'
        return [404, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><title>missing</title>']]
      when '/form'
        <<~HTML
          <!doctype html><html><head><meta charset="utf-8"><title>form</title></head><body>
            <form method="post" action="/posted"><input name="q" value="own"><button id="own">own</button></form>
            <iframe name="fr" srcdoc="<a id=top href=/third target=_top>top</a>"></iframe>
          </body></html>
        HTML
      when '/posted'
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>posted</title></head><body><p id=\"posted\">#{env['REQUEST_METHOD']} #{env['rack.input']&.read}</p></body></html>"
      else
        '<!doctype html><html><head><meta charset="utf-8"><title>third</title></head><body><p id="third">THIRD</p></body></html>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit('/') }
  after  { session.reset_session! }

  def open_popup = session.window_opened_by { session.find(:css, '#open').click }

  it 'is one of the session\'s windows, its own document what a find in it sees' do
    popup = open_popup
    expect(session.windows.size).to eq(2)
    session.within_window(popup) do
      expect(session).to have_css('#in', text: 'IN')
      expect(session).to have_no_css('#main')
      expect(session.current_url).to eq('about:blank')
      expect(session.title).to eq('blank')
      expect(session.html).to include('id="in"')
    end
    expect(session).to have_css('#main')
    expect(session).to have_no_css('#in')
  end

  it 'takes a click, a fill and a script in its own document' do
    popup = open_popup
    session.within_window(popup) do
      session.fill_in('field', with: 'typed')
      session.click_button('b')
      expect(session).to have_title('clicked:typed')
      expect(session.evaluate_script('window.opener.document.title')).to eq('main')
      expect(session.evaluate_script('document.getElementById("in").textContent')).to eq('IN')
    end
    expect(session.evaluate_script('window.popup.document.title')).to eq('clicked:typed')
  end

  it 'enters its frames, and back to its own document at :top' do
    popup = open_popup
    session.within_window(popup) do
      session.within_frame('fr') { expect(session).to have_css('#deep', text: 'DEEP') }
      expect(session).to have_css('#in')
    end
  end

  it 'follows a link in it, its URL and title the new document\'s, its opener\'s page kept' do
    popup = open_popup
    session.within_window(popup) do
      session.click_link('next')
      expect(session).to have_css('#second')
      expect(session.current_url).to end_with('/second')
      expect(session.title).to eq('second')
    end
    expect(session).to have_css('#main')
    expect(session.evaluate_script('window.popup.document.title')).to eq('second')
  end

  it 'visits, goes back and forward, and refreshes in it' do
    popup = open_popup
    session.within_window(popup) do
      session.visit('/second')
      expect(session).to have_css('#second')
      session.visit('/third')
      expect(session).to have_css('#third')
      session.go_back
      expect(session).to have_css('#second')
      session.go_forward
      expect(session).to have_css('#third')
      session.execute_script('document.body.dataset.mark = "1"')
      session.refresh
      expect(session).to have_css('#third')
      expect(session.evaluate_script('document.body.dataset.mark')).to be_nil
    end
    expect(session.current_url).to end_with('/')
  end

  it 'has a viewport of its own, which a resize of it moves alone' do
    popup = open_popup
    popup.resize_to(400, 300)
    expect(popup.size).to eq([400, 300])
    session.within_window(popup) do
      expect(session.evaluate_script('[innerWidth, innerHeight]')).to eq([400, 300])
    end
    expect(session.evaluate_script('[innerWidth, innerHeight]')).to eq([1024, 768])
    expect(session.current_window.size).to eq([1024, 768])
  end

  it 'paints its own document' do
    popup = open_popup
    path = File.join(Dir.mktmpdir, 'popup.png')
    session.within_window(popup) { session.save_screenshot(path) }
    expect(File.binread(path, 8)).to eq("\x89PNG\r\n\x1A\n".b)
  end

  # (…a top-level traversable of its own, which its opener's navigation leaves as it is: its `opener` the new document's
  # window, the opener browsing context's)
  it 'outlives a navigation of the page that opened it' do
    popup = open_popup
    session.within_window(popup) { session.execute_script('window.ticks = 0; setInterval(() => ticks++, 10)') }
    session.visit('/second')
    expect(session).to have_css('#second')
    expect(session.windows.size).to eq(2)
    session.within_window(popup) do
      expect(session).to have_css('#in', text: 'IN')
      expect(session.evaluate_script('window.opener.document.title')).to eq('second')
      sleep 0.2
      expect(session.evaluate_script('ticks')).to be > 0
      session.fill_in('field', with: 'still')
      session.click_button('b')
      expect(session).to have_title('clicked:still')
    end
  end

  it 'closes, its opener seeing it closed, the session one window again' do
    popup = open_popup
    popup.close
    expect(session.windows.size).to eq(1)
    expect(session.evaluate_script('window.popup.closed')).to be(true)
  end

  it 'leaves the session\'s windows as its script closes it' do
    popup = open_popup
    session.within_window(popup) { session.execute_script('window.close()') }
    expect(session.windows.size).to eq(1)
    expect { session.within_window(popup) { nil } }.to raise_error(Capybara::WindowError)
  end

  it 'raises what the app raised for a visit in it, and answers the status its document was served with' do
    popup = open_popup
    session.within_window(popup) do
      expect { session.visit('/boom') }.to raise_error(RuntimeError, 'boom')
      session.visit('/missing')
      expect([session.status_code, session.response_headers['Content-Type']]).to eq([404, 'text/html'])
    end
  end

  it 'visits about:blank in it as a new opaque origin, no referrer' do
    popup = open_popup
    session.within_window(popup) do
      session.visit('/second')
      session.visit('about:blank')
      expect(session.evaluate_script('[self.origin, document.referrer]')).to eq(['null', ''])
    end
  end

  it 'submits a form in it, and from a frame of it navigates it at _top, the scope back at its new document' do
    popup = open_popup
    session.within_window(popup) do
      session.visit('/form')
      session.within_frame('fr') do
        session.click_link('top')
        expect(session).to have_css('#third')
      end
      session.visit('/form')
      session.click_button('own')
      expect(session).to have_css('#posted', text: 'POST q=own')
    end
  end

  # (…a submission its script plans — `form.submit()`, `requestSubmit()` — as a click's: its own realm's plan, taken as
  # the task ends)
  it 'submits a form its script submits, by submit() and by requestSubmit()' do
    popup = open_popup
    session.within_window(popup) do
      session.visit('/form')
      session.execute_script('document.forms[0].submit()')
      expect(session).to have_css('#posted', text: 'POST q=own')
      session.visit('/form')
      session.execute_script('setTimeout(() => document.forms[0].requestSubmit(), 10)')
      expect(session).to have_css('#posted', text: 'POST q=own')
    end
    expect(session).to have_css('#main')
  end

  it 'takes a form its opener submits into it by its name' do
    session.execute_script(<<~JS)
      window.w = window.open('', 'named');
      const f = document.createElement('form');
      f.method = 'post'; f.action = '/posted'; f.target = 'named';
      f.innerHTML = '<input name="q" value="opener">';
      document.body.appendChild(f);
      f.submit();
    JS
    session.within_window(session.windows.last) do
      expect(session).to have_css('#posted', text: 'POST q=opener')
    end
  end

  # HTML "create and initialize a Document object": a navigation of its initial about:blank to a document of its origin
  # keeps its Window — what its opener set on it, its listeners — but nothing of the document it replaces; one whose
  # document was opened (`document.open()`) is no initial about:blank, and keeps none.
  it 'keeps the Window of its initial about:blank for a document of its origin, and nothing of that document' do
    session.execute_script(<<~JS)
      window.w = window.open();
      w.kept = 'kept';
      w.addEventListener('load', () => { w.loads = (w.loads || 0) + 1; });
      w.document.addEventListener('click', () => { w.clicked = true; });
      w.document.designMode = 'on';
      w.location = '/second';
    JS
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    session.execute_script('w.document.body.click()')
    expect(session.evaluate_script('[w.kept, w.loads, w.clicked, w.document.designMode]')).to eq(['kept', 1, nil, 'off'])
  end

  it 'makes a Window of its own for a window whose document was opened' do
    popup = open_popup
    session.execute_script("window.popup.kept = 'kept'; window.popup.location = '/second'")
    session.within_window(popup) do
      expect(session).to have_css('#second')
      expect(session.evaluate_script('window.kept')).to be_nil
    end
  end

  it 'keeps the frame entered in it while its opener navigates' do
    popup = open_popup
    session.within_window(popup) do
      session.within_frame('fr') do
        session.execute_script("parent.opener.location = '/second'")
        expect(session).to have_css('#deep')
      end
    end
    expect(session).to have_css('#second')
  end

  it "reports the frames of its opener's page that page's navigation discarded as closed" do
    session.visit('/form')
    session.execute_script("window.w = window.open(); w.f = window.frames[0];")
    session.visit('/second')
    session.within_window(session.windows.last) do
      expect(session.evaluate_script('[f.closed, f.parent === null]')).to eq([true, true])
    end
    session.visit('/third')
    session.within_window(session.windows.last) do
      expect(session.evaluate_script('[f.closed, f.parent === null]')).to eq([true, true])
    end
  end

  # (…however many navigations after: its WindowProxy answers as a browsing context's gone, the document it showed read
  # still — Chrome measured: `closed` true, `parent` null, its title and text its document's)
  it "keeps a held frame of its opener's page closed across many navigations of that page, its document readable" do
    session.visit('/form')
    session.execute_script("window.w = window.open(); w.eval(\"window.f = opener.frames[0]\");")
    70.times {|i| session.visit(i.even? ? '/second' : '/third') }
    session.within_window(session.windows.last) do
      expect(session.evaluate_script('[f.closed, f.parent, f.top, f.document.title, f.document.querySelector("a").id]')).to eq([true, nil, nil, '', 'top'])
    end
  end

  # HTML "copy the session storage": its own, a copy of its opener's as it opened (Chrome measured: the opener's item
  # seen, neither's later writes the other's).
  it "has a sessionStorage of its own, a copy of its opener's" do
    session.execute_script(<<~JS)
      sessionStorage.setItem('a', '1');
      window.w = window.open();
      w.sessionStorage.setItem('b', '2');
      sessionStorage.setItem('c', '3');
    JS
    expect(session.evaluate_script("[w.sessionStorage.getItem('a'), sessionStorage.getItem('b'), w.sessionStorage.getItem('c')]"))
      .to eq(['1', nil, nil])
  end

  # (…its isolate kept for it, the opener's window gone: WPT opener-closed.html — its `opener` none then — and let go of
  # with it)
  it 'outlives the window that opened it, its opener none then' do
    host  = session.open_new_window
    popup = session.within_window(host) do
      session.visit('/')
      session.window_opened_by { session.execute_script("window.open().document.write('<p id=second>SECOND</p>')") }
    end
    host.close
    expect(session.windows.size).to eq(2)
    session.within_window(popup) do
      expect(session).to have_css('#second')
      expect(session.evaluate_script('window.opener')).to be_nil
    end
    popup.close
    expect([session.windows.size, session.driver.window_browsers.size]).to eq([1, 1])
  end

  # (…HTML's entry settings object: the realm a dispatch enters for its listener — navigables.rs `entryRealm` — not the
  # window's whose Location it is, at its about:blank of its opener's base all the same: /dir/next, not /next)
  it "is navigated by a listener of its opener's to a URL resolved against the opener's document" do
    session.visit('/dir/page')
    session.execute_script(<<~JS)
      window.w = window.open();
      w.location = '/form';
    JS
    session.within_window(session.windows.last) { expect(session).to have_title('form') }
    session.execute_script("addEventListener('custom', () => { w.location.href = 'next'; }); dispatchEvent(new Event('custom'));")
    session.within_window(session.windows.last) { expect(session).to have_current_path('/dir/next') }
  end

  # (…a form of its opener's posted to it by its name, a traversal back to that entry posting again: its entry's
  # resource — session_history.rs `commitWindowEntry`)
  it 'posts again for a traversal back to an entry a form posted to it' do
    session.execute_script("window.w = window.open('', 'named'); w.location = '/second';")
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<form target=named method=post action=/posted><input name=k value=v></form>');
      document.forms[0].submit();
    JS
    session.within_window(session.windows.last) do
      expect(session).to have_text('POST k=v')
      session.go_back
      expect(session).to have_css('#second')
      session.go_forward
      expect(session).to have_text('POST k=v')
    end
  end

  # (…a navigation to a javascript: URL its ongoing one until its task runs: one planned before it aborted, one after it
  # aborting it — HTML "navigate to a javascript: URL", navigation_plan.rs `planJavascript`)
  it 'runs a javascript: URL its opener navigates it to in place of the navigation planned before it, none planned after' do
    session.execute_script("window.w = window.open(); w.location = '/second';")
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    session.execute_script("w.location = '/third'; w.location = 'javascript:document.title = \"ran\"'")
    expect(session.evaluate_script('[w.document.title, w.location.pathname]')).to eq(['ran', '/second'])
    session.execute_script("w.location = 'javascript:document.title = \"again\"'; w.location = '/third'")
    session.within_window(session.windows.last) { expect(session).to have_css('#third') }
    expect(session.evaluate_script('w.document.title')).to eq('third')
  end

  # (…but not a form's submission its click listener made, whose navigation HTML "plan to navigate" begins in a task
  # after the `javascript:` hyperlink's — and ends it)
  it "submits a form a javascript: link's own click listener submitted" do
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<form method="post" action="/posted"><input name="q" value="v"></form>' +
        '<a id="js" href="javascript:void(0)" onclick="document.forms[0].submit()">js</a>');
    JS
    session.find(:css, '#js').click
    expect(session).to have_text('POST q=v')
  end

  # (…its host page's document destroyed with its window — HTML "destroy a document": its timers run no more — the
  # pop-up's own going on)
  it "outlives the window that opened it, whose document's tasks run no more" do
    host  = session.open_new_window
    popup = session.within_window(host) do
      session.visit('/')
      session.window_opened_by do
        session.execute_script("window.w = window.open(); window.n = 0; setInterval(() => { w.document.title = 'tick' + ++n; }, 50);")
      end
    end
    host.close
    session.within_window(popup) do
      session.execute_script("window.k = 0; setInterval(() => k++, 50);")
      before = session.title
      session.evaluate_async_script('setTimeout(arguments[0], 500)')
      expect([session.title, session.evaluate_script('k') > 2]).to eq([before, true])
    end
  end

  # (…the entry realm the context the host entered, where no listener of several realms named one: a page of one realm
  # opening the window in the listener that navigates it — HTML's entry settings object)
  it "is navigated by the listener that opened it to a URL resolved against its opener's document" do
    session.visit('/dir/page')
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<button id="go">go</button>');
      document.getElementById('go').addEventListener('click', () => {
        window.w = window.open();
        w.document.write('<base href="/elsewhere/">');
        w.location.href = 'next';
      });
    JS
    popup = session.window_opened_by { session.click_button('go') }
    session.within_window(popup) { expect(session).to have_current_path('/dir/next') }
  end

  # (…a 307 keeps the POST — Fetch "HTTP-redirect fetch" — which a reload of its entry posts again)
  it 'posts again for a reload of an entry a 307 redirect kept a POST' do
    session.execute_script("window.w = window.open('', 'named'); w.location = '/second';")
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<form target=named method=post action=/r307><input name=k value=v></form>');
      document.forms[0].submit();
    JS
    session.within_window(session.windows.last) do
      expect(session).to have_text('POST k=v')
      session.refresh
      expect(session).to have_text('POST k=v')
    end
  end

  # (…a frame's navigable, not the realm of the document it had: its next document the opener then, its removal none)
  it 'has the frame that opened it its opener across a navigation of that frame' do
    session.execute_script("document.body.insertAdjacentHTML('beforeend', '<iframe id=\"fo\" src=\"/second\"></iframe>')")
    session.within_frame('fo') { expect(session).to have_css('#second') }
    session.execute_script("window.f = document.getElementById('fo'); window.w2 = f.contentWindow.eval('window.open()');")
    session.execute_script("f.src = '/third'")
    session.within_frame('fo') { expect(session).to have_css('#third') }
    expect(session.evaluate_script('w2.opener.location.pathname')).to eq('/third')
    session.execute_script('f.remove()')
    expect(session.evaluate_script('w2.opener')).to be_nil
  end

  # (…HTML keeps the name in the entry's document state: a traversal back to one of another origin brings back its name,
  # which the navigation away from it cleared)
  it 'has the name of the entry a traversal goes back to', :every_host_local do
    session.execute_script("window.w = window.open(); w.location = '/second';")
    session.within_window(session.windows.last) do
      expect(session).to have_css('#second')
      session.execute_script("window.name = 'kept'; opener = null;")
      session.visit('http://other.test/third')
      expect(session.evaluate_script('window.name')).to eq('')
      session.go_back
      expect(session).to have_css('#second')
      expect(session.evaluate_script('window.name')).to eq('kept')
    end
  end

  # (…a script its opener writes into it run with its own document the entry: HTML "prepare to run script")
  it "resolves a URL a script its opener writes into it navigates it to against its own document" do
    session.visit('/dir/page')
    session.execute_script(<<~JS)
      window.w = window.open();
      w.document.write('<base href="/elsewhere/"><script>location.href = "next"<\\/script>');
    JS
    session.within_window(session.windows.last) { expect(session).to have_current_path('/elsewhere/next') }
  end

  # (…its documents after its host's, whose tasks are gone: loaded, traversed — its own event loop going on)
  it 'loads and traverses its documents after the window that opened it closed' do
    host  = session.open_new_window
    popup = session.within_window(host) do
      session.visit('/')
      session.window_opened_by { session.execute_script("window.open().document.write('<a id=\"go\" href=\"/second\">go</a>')") }
    end
    host.close
    session.within_window(popup) do
      session.click_link('go')
      expect(session).to have_css('#second')
      expect(session.evaluate_script('document.readyState')).to eq('complete')
      session.execute_script("location.href = '/third'")
      expect(session).to have_css('#third')
      session.go_back
      expect(session).to have_css('#second')
    end
  end

  # (…a hyperlink's to a new window its click listener followed: that navigable's navigation, which a `javascript:` URL
  # of this one ends none of)
  it "opens the window a javascript: link's click listener opened by a target=_blank link" do
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend', '<a id="blank" href="/second" target="_blank">b</a>' +
        '<a id="js" href="javascript:void(0)" onclick="document.getElementById(\\'blank\\').click()">js</a>');
    JS
    popup = session.window_opened_by { session.find(:css, '#js').click }
    session.within_window(popup) { expect(session).to have_css('#second') }
  end

  # (…a frame's `javascript:` URL by the same rule as a top-level document's: ending the location navigation planned
  # before it, ended by one planned after it)
  it "runs a frame's javascript: URL in place of the navigation planned before it, none planned after" do
    session.execute_script("document.body.insertAdjacentHTML('beforeend', '<iframe id=\"jf\" src=\"/second\"></iframe>')")
    session.within_frame('jf') { expect(session).to have_css('#second') }
    session.execute_script("window.ran = 0; window.jf = document.getElementById('jf'); jf.contentWindow.eval(\"location.href = '/third'; location.href = 'javascript:void(parent.ran = 1)'\")")
    expect(session.evaluate_script('[ran, jf.contentWindow.location.pathname]')).to eq([1, '/second'])
    session.execute_script("ran = 0; jf.contentWindow.eval(\"location.href = 'javascript:void(parent.ran = 1)'; location.href = '/third'\")")
    session.within_frame('jf') { expect(session).to have_css('#third') }
    expect(session.evaluate_script('ran')).to eq(0)
  end

  # (…a promise job's entry its handler's realm, not the realm of the listener that queued it — HTML)
  it "resolves a URL a frame's function navigates it to, run as a promise job of a listener of the page, against the frame's document" do
    session.visit('/dir/page')
    session.execute_script("document.body.insertAdjacentHTML('beforeend', '<iframe id=\"pf\" src=\"/f/doc\"></iframe><button id=\"btn\">b</button>')")
    session.within_frame('pf') { expect(session).to have_css('#third') }
    session.execute_script(<<~JS)
      const fn = document.getElementById('pf').contentWindow.eval("(function () { location.href = 'y'; })");
      document.getElementById('btn').addEventListener('click', () => { Promise.resolve().then(fn); });
    JS
    session.click_button('btn')
    session.within_frame('pf') { expect(session).to have_css('#third') }
    expect(session.evaluate_script("document.getElementById('pf').contentWindow.location.pathname")).to eq('/f/y')
  end

  # A reload and a `javascript:` URL begun in one task, either first: the URL's script runs, then the reload makes the
  # document again — HTML "reload a navigable" sets no ongoing navigation, and "apply the history step" unloads the
  # document by a task (step 12) queued on its event loop after the URL's (navigation_plan.rs `reload_waits`). On the
  # page, in a frame and in a window of this isolate alike.
  context 'navigated to a javascript: URL and reloaded in one task' do
    include PollUntil

    def both_orders
      ['location.href = JS; location.reload();', 'location.reload(); location.href = JS;'].map {|order| yield order }
    end

    it 'runs the URL, then reloads the page' do
      results = both_orders do |order|
        session.visit('/')
        session.execute_script("sessionStorage.ran = 0; document.title = 'mark'; const JS = 'javascript:void(sessionStorage.ran = 1)'; #{order}")
        expect(session).to have_title('main')
        session.evaluate_script('sessionStorage.ran')
      end
      expect(results).to eq(%w[1 1])
    end

    it 'runs the URL, then reloads a frame' do
      results = both_orders do |order|
        session.visit('/')
        session.execute_script("document.body.insertAdjacentHTML('beforeend', '<iframe id=\"rf\" src=\"/second\"></iframe>')")
        session.within_frame('rf') { expect(session).to have_css('#second') }
        session.execute_script("window.ran = 0; document.getElementById('rf').contentWindow.eval(#{"document.title = 'mark'; const JS = 'javascript:void(parent.ran = 1)'; #{order}".to_json})")
        expect(poll_until { session.evaluate_script("document.getElementById('rf').contentDocument.title") == 'second' }).to be(true)
        session.evaluate_script('ran')
      end
      expect(results).to eq([1, 1])
    end

    it 'runs the URL, then reloads a window of this isolate' do
      results = both_orders do |order|
        session.visit('/')
        session.execute_script("window.w = window.open(); w.location = '/second';")
        session.within_window(session.windows.last) { expect(session).to have_css('#second') }
        session.execute_script("window.ran = 0; w.eval(#{"document.title = 'mark'; const JS = 'javascript:void(opener.ran = 1)'; #{order}".to_json})")
        session.within_window(session.windows.last) { expect(session).to have_title('second') }
        ran = session.evaluate_script('ran')
        session.windows.last.close
        ran
      end
      expect(results).to eq([1, 1])
    end
  end

  # (…and a navigation one of those tasks begins outruns it: the traversal queue runs in parallel with the document's tasks,
  # the reload's history step taken after them — Chrome 156 and Firefox 159 measured: the page and a pop-up go to the
  # task's URL, reloading nothing)
  context 'reloaded with a task queued that navigates' do
    it 'goes to the task\'s URL on the page' do
      session.execute_script("document.title = 'mark'; setTimeout(() => { location.href = '/second'; }, 0); location.reload();")
      expect(session).to have_css('#second')
    end

    it "goes to the task's URL in a window of this isolate" do
      session.execute_script("window.w = window.open(); w.location = '/third';")
      session.within_window(session.windows.last) { expect(session).to have_css('#third') }
      session.execute_script("w.eval(\"setTimeout(() => { location.href = '/second'; }, 0); location.reload();\")")
      session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    end
  end

  # (…but the tasks queued then alone: an interval begun with it runs a tick or two of them, its later ones — each scheduled
  # again after — none it waits on)
  context 'reloaded with an interval running' do
    include PollUntil

    it 'reloads the page after a few ticks of it' do
      session.execute_script("sessionStorage.t = 0; document.title = 'mark'; setInterval(() => sessionStorage.t++, 0); location.reload();")
      expect(session).to have_title('main')
      expect(session.evaluate_script('+sessionStorage.t')).to be < 16
    end

    it 'reloads a frame after a few ticks of it' do
      session.execute_script("document.body.insertAdjacentHTML('beforeend', '<iframe id=\"if\" src=\"/second\"></iframe>')")
      session.within_frame('if') { expect(session).to have_css('#second') }
      session.execute_script("window.t = 0; document.getElementById('if').contentWindow.eval(\"document.title = 'mark'; setInterval(() => parent.t++, 0); location.reload()\")")
      expect(poll_until { session.evaluate_script("document.getElementById('if').contentDocument.title") == 'second' }).to be(true)
      expect(session.evaluate_script('t')).to be < 16
    end

    it 'reloads a window of this isolate after a few ticks of it' do
      session.execute_script("window.w = window.open(); w.location = '/second';")
      session.within_window(session.windows.last) { expect(session).to have_css('#second') }
      session.execute_script("window.t = 0; w.eval(\"document.title = 'mark'; setInterval(() => opener.t++, 0); location.reload()\")")
      session.within_window(session.windows.last) { expect(session).to have_title('second') }
      expect(session.evaluate_script('t')).to be < 16
    end
  end

  it 'is the opener of a pop-up it opens at a URL' do
    popup = open_popup
    session.within_window(popup) { session.execute_script("window.open('/second', 'deep')") }
    expect(session.driver.send(:window_entries).last[:opener]).to eq(popup.handle)
  end

  # (…by a link of its host's page that names it: another isolate's script, which no WindowProxy of it could be handed,
  # opens a window of its own meanwhile — R13 S6)
  it 'is found by its name by a link of the page that opened it' do
    session.execute_script(<<~JS)
      window.w = window.open('', 'nm');
      const a = document.createElement('a');
      a.id = 'to-nm'; a.href = '/second'; a.target = 'nm'; a.textContent = 'to nm';
      document.body.appendChild(a);
    JS
    session.click_link('to-nm')
    expect(session.windows.size).to eq(2)
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
  end

  it 'opens a pop-up at a URL with a copy of its own sessionStorage, not its host page\'s' do
    session.execute_script("sessionStorage.setItem('page', '1'); window.w = window.open(); w.sessionStorage.setItem('popup', '1'); sessionStorage.setItem('late', '1');")
    session.execute_script("w.eval(\"window.open('/third')\")")
    session.within_window(session.windows.last) do
      expect(session).to have_css('#third')
      expect(session.evaluate_script("['page', 'popup', 'late'].map((k) => sessionStorage.getItem(k))")).to eq(['1', '1', nil])
    end
  end

  it 'takes a modal its document raises, the commands of the block in the window each addresses' do
    popup = open_popup
    session.within_window(popup) do
      message = session.accept_alert { session.execute_script("setTimeout(() => alert('hi'), 0)") }
      expect(message).to eq('hi')
      expect(session).to have_css('#in')
    end
  end

  it 'renews the document it keeps: its adopted sheets, its selection, the observers on it none of the next' do
    session.execute_script(<<~JS)
      window.w = window.open();
      const sheet = new w.CSSStyleSheet();
      w.document.adoptedStyleSheets = [sheet];
      w.document.body.textContent = 'x';
      w.getSelection().selectAllChildren(w.document.body);
      window.records = 0;
      new MutationObserver((r) => { records += r.length; }).observe(w.document, {childList: true, subtree: true});
      w.location = '/second';
    JS
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    expect(session.evaluate_script('[w.document.adoptedStyleSheets.length, w.getSelection().rangeCount, records]')).to eq([0, 0, 0])
  end

  it 'keeps the observers of the nodes of its realm out of the document it renews' do
    session.execute_script(<<~JS)
      window.w = window.open();
      window.parsed = new w.DOMParser().parseFromString('<p>x</p>', 'text/html');
      window.detached = w.document.createElement('div');
      window.recs = [];
      const mo = new MutationObserver((rs) => rs.forEach((r) => recs.push(r.type)));
      mo.observe(parsed.body, {childList: true});
      mo.observe(detached, {attributes: true});
      w.location = '/second';
    JS
    session.within_window(session.windows.last) { expect(session).to have_css('#second') }
    session.execute_script("parsed.body.append('y'); detached.setAttribute('f1', '1');")
    expect(session.evaluate_script('recs')).to eq(%w[childList attributes])
  end

  it 'keeps the document of a frame it removed readable across a navigation of its opener' do
    popup = open_popup
    session.within_window(popup) do
      session.execute_script(<<~JS)
        const frame = document.createElement('iframe');
        frame.srcdoc = '<title>RM</title>';
        document.body.appendChild(frame);
      JS
      expect(session.evaluate_script("document.querySelectorAll('iframe')[1].contentDocument.title")).to eq('RM')
      session.execute_script("const f = document.querySelectorAll('iframe')[1]; window.rd = f.contentDocument; f.remove();")
    end
    session.visit('/second')
    session.within_window(popup) { expect(session.evaluate_script('rd.title')).to eq('RM') }
  end
end

# …beside the frames of the page that opened it — one of another origin, one of its own: the driver's scope back at that
# page's, its frames entered from there, however the window was addressed; and a frame's script finding the window by its
# name, its own origin's or another's.
RSpec.describe 'a window made in its opener\'s isolate, beside the frames of its opener\'s page', :every_host_local do
  let(:session) {
    simulated_session(lambda {|env|
      req         = Rack::Request.new(env)
      sandbox     = %( sandbox="#{req.params['sandbox']}") if req.params['sandbox']
      frame_opens = req.params.key?('frame_opens')
      body        = case req.path
      when '/'
        <<~HTML
          <!doctype html><html><head><meta charset="utf-8"><title>main</title></head><body>
            <p id="main">MAIN</p>
            <form action="http://a.test/landed" target="w"><button>form</button></form>
            <form action="javascript:document.title = 'by script'" target="w"><button>script action</button></form>
            <iframe src="http://b.test/frame"#{sandbox}></iframe>
            <iframe src="http://a.test/frame#{'?opens' if frame_opens}"#{sandbox}></iframe>
            <script>#{open_w unless frame_opens}</script>
          </body></html>
        HTML
      when '/frame'
        <<~HTML
          <!doctype html><html><head><meta charset="utf-8"></head><body>
            <p id="frame">#{req.host}</p>
            <button id="script">script</button>
            <button id="url">url</button>
            <button id="inline" onclick="open('', 'w').location = 'http://a.test/landed'">inline</button>
            <form action="http://a.test/landed" target="w"><button>form</button></form>
            <form action="javascript:document.title = 'by script'" target="w"><button>script action</button></form>
            <form id="post" method="post" action="http://a.test/posted" target="w"><input name="q" value="v"></form>
            <button id="post-away">post away</button>
            <script>
              document.getElementById('script').addEventListener('click', () => { open('', 'w').location = 'http://a.test/landed'; });
              document.getElementById('url').addEventListener('click', () => { open('http://a.test/landed', 'w'); });
              document.getElementById('post-away').addEventListener('click', () => {
                document.getElementById('post').submit();
                location = '/landed';
              });
              #{open_w if req.query_string == 'opens'}
            </script>
          </body></html>
        HTML
      when '/posted'
        "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><p id=\"posted\">#{req.request_method} q=#{req.POST['q']} #{env['HTTP_ORIGIN']} #{env['HTTP_REFERER']}</p></body></html>"
      else
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>landed</title></head><body><p id=\"landed\">#{req.host}#{req.path}</p></body></html>"
      end
      [200, {'content-type' => 'text/html'}, [body]]
    })
  }
  # (…opened by the page's script, or by its frame of its own origin's)
  let(:open_w) {
    <<~JS
      window.name = 'main';
      window.w = window.open('', 'w');
      w.document.write(
        '<!doctype html><title>blank</title><p id="in">IN</p><iframe srcdoc="<p id=deep>DEEP</p>"></iframe>' +
        '<form action="http://a.test/landed" target="main"><button>to main</button></form>' +
        '<iframe src="http://b.test/frame"></iframe>'
      );
      w.document.close();
    JS
  }
  let(:path)  { '/' }
  let(:main)  { session.windows.first }
  let(:popup) { session.windows[1] }

  before do
    session.visit("http://a.test#{path}")
    expect(session.windows.size).to eq(2)
  end

  def expect_page_frames
    session.within_frame(0) { expect(session).to have_css('#frame', text: 'b.test') }
    session.within_frame(1) { expect(session).to have_css('#frame', text: 'a.test') }
    expect(session).to have_css('#main')
  end

  it "enters the frames of its opener's page after a block in it" do
    session.within_window(popup) { expect(session).to have_css('#in') }
    expect_page_frames
  end

  it "enters the frames of its opener's page after a switch to it and back" do
    session.switch_to_window(popup)
    expect(session).to have_css('#in')
    session.within_frame(0) { expect(session).to have_css('#deep') }
    session.switch_to_window(main)
    expect_page_frames
  end

  it "enters a frame of its own in a block in it, the scope back at its opener's page after" do
    session.within_window(popup) do
      session.within_frame(0) { expect(session).to have_css('#deep') }
      expect(session).to have_css('#in')
    end
    expect_page_frames
  end

  # (…Capybara refuses a window switched to in a frame's block; the driver's switch, which nothing refuses, leaves the
  # frame entered in the page as it was)
  it "leaves a frame entered in its opener's page entered across a switch to it" do
    session.within_frame(0) do
      expect { session.within_window(popup) {} }.to raise_error(Capybara::ScopeError)
      session.driver.switch_to_window(popup.handle)
      expect(session).to have_css('#in')
      session.driver.switch_to_window(main.handle)
      expect(session).to have_css('#frame', text: 'b.test')
    end
    expect(session).to have_css('#main')
  end

  # (HTML "the rules for choosing a navigable": the window a frame's `window.open` names is one its browsing context is
  # familiar with — an auxiliary one whose opener is the frame's top-level traversable — and a `location` set navigates
  # it from another origin as from its own: Location's `href` setter is a cross-origin one, "allowed by sandboxing to
  # navigate" its only check)
  [
    [0, 'another origin', 'http://b.test http://b.test/'],
    [1, 'its origin', 'http://a.test http://a.test/frame']
  ].each do |index, origin, request_from|
    it "is found by its name by a script of a frame of #{origin}, which navigates it" do
      session.within_frame(index) do
        expect(session.evaluate_script("open('', 'w').closed")).to be(false)
        session.click_button('script')
        expect(session).to have_css('#frame')
      end
      expect(session.windows.size).to eq(2)
      session.within_window(popup) do
        expect(session).to have_css('#landed', text: 'a.test/landed')
        expect(session.current_url).to eq('http://a.test/landed')
      end
    end

    it "is navigated by a form a frame of #{origin} submits into it by its name" do
      session.within_frame(index) do
        session.click_button('form')
        expect(session).to have_css('#frame')
      end
      expect(session.windows.size).to eq(2)
      session.within_window(popup) { expect(session).to have_css('#landed', text: 'a.test/landed') }
    end

    # (…the request the frame's document made, its Origin and its Referer, though the frame navigated away as it began)
    it "takes a POST a frame of #{origin} submits into it by its name, the frame navigated away after" do
      session.within_frame(index) do
        session.click_button('post-away')
        expect(session).to have_css('#landed')
      end
      session.within_window(popup) { expect(session).to have_css('#posted', text: "POST q=v #{request_from}") }
    end

    # (…but an inline event handler's `open` is its document's, whose scope comes before the global's in the handler's
    # (HTML "getting the current value of the event handler"): `document.open('', 'w')`, two arguments, reopens the
    # frame's own document, whose `location` it then sets — the frame navigated, the window left as it was. Chrome and
    # Firefox measured: `open === document.open` in an attribute handler)
    it "is not what an inline handler's `open` in a frame of #{origin} names: the frame's document is" do
      session.within_frame(index) do
        session.click_button('inline')
        expect(session).to have_css('#landed', text: 'a.test/landed')
      end
      expect(session.windows.size).to eq(2)
      session.within_window(popup) { expect(session).to have_css('#in') }
    end
  end

  it "is navigated by a form its opener's page submits into it by its name" do
    session.click_button('form')
    expect(session.windows.size).to eq(2)
    session.within_window(popup) { expect(session).to have_css('#landed', text: 'a.test/landed') }
    expect(session).to have_css('#main')
  end

  # (…a `javascript:` action run in it where the form's document is of its origin: HTML "navigate to a javascript: URL")
  it 'runs the javascript: action of a form submitted into it by its name, from a document of its origin' do
    session.click_button('script action')
    session.within_window(popup) { expect(session).to have_title('by script') }
    session.execute_script("w.document.title = 'blank'")
    session.within_frame(1) { session.click_button('script action') }
    session.within_window(popup) { expect(session).to have_title('by script') }
  end

  it 'ignores the javascript: action of a form submitted into it from a frame of another origin' do
    session.within_frame(0) { session.click_button('script action') }
    session.within_window(popup) { expect(session).to have_title('blank') }
  end

  # (…a frame of another origin in it, which is not familiar with its opener's page: not of its origin, not its
  # top-level traversable — the window is — and the page no auxiliary one; the window it opens by the page's name a new
  # one, the page left as it was. Firefox and HTML; Chrome navigates the page, a departure navigables.rs
  # `find_navigable` notes)
  [
    ['a script', "open('http://a.test/landed', 'main')"],
    ['a link', "const a = document.createElement('a'); a.href = 'http://a.test/landed'; a.target = 'main'; document.body.append(a); a.click()"],
    ['a form', "const f = document.createElement('form'); f.action = 'http://a.test/landed'; f.target = 'main'; document.body.append(f); f.submit()"]
  ].each do |by, script|
    it "opens a window of its own for #{by} of a frame of another origin in it that names its opener's page" do
      session.within_window(popup) do
        session.within_frame(1) { session.execute_script(script) }
      end
      expect(session).to have_css('#landed', count: 0)
      expect(session.windows.size).to eq(3)
      session.within_window(session.windows.last) { expect(session).to have_css('#landed', text: 'a.test/landed') }
      expect(session).to have_css('#main')
    end
  end

  it "submits a form into its opener's page by that page's name" do
    session.within_window(popup) { session.click_button('to main') }
    expect(session.windows.size).to eq(2)
    expect(session).to have_css('#landed', text: 'a.test/landed')
    session.within_window(popup) { expect(session).to have_css('#in') }
  end

  # A frame its name finds no window for — one not familiar with it, or one sandboxed against navigating it — opens a
  # window of its own by that name, the window of the name left as it was, whether it gave a URL or set the location of
  # the window it got (Chrome measured; Firefox not).
  shared_examples 'a frame it is not found from' do |index|
    it 'opens a window of its own for a script that sets its location' do
      session.within_frame(index) do
        expect(session.evaluate_script("(() => { const r = open('', 'w'); r.location = 'http://a.test/landed'; return r.closed; })()")).to be(false)
      end
      expect(session.windows.size).to eq(3)
      session.within_window(session.windows.last) { expect(session).to have_css('#landed', text: 'a.test/landed') }
      session.within_window(popup) { expect(session).to have_css('#in') }
    end

    it 'opens a window of its own at the URL a script gives' do
      session.within_frame(index) { session.click_button('url') }
      expect(session.windows.size).to eq(3)
      session.within_window(session.windows.last) { expect(session).to have_css('#landed', text: 'a.test/landed') }
      session.within_window(popup) { expect(session).to have_css('#in') }
    end
  end

  # (…a frame of another origin than the frame that opened it: HTML "familiar with" holds through none of its rules — not
  # of its origin, not its top-level traversable, not a frame, and its opener a frame the naming one is not familiar with
  # either: of another origin, and no ancestor of it of the naming frame's)
  context 'opened by a frame of the page, named by a frame of another origin' do
    let(:path) { '/?frame_opens' }

    include_examples 'a frame it is not found from', 0
  end

  # (…a frame sandboxed with `allow-scripts allow-popups`, which is familiar with the window but may not navigate it:
  # HTML "allowed by sandboxing to navigate" refuses it a window that is not its top-level traversable and of which it is
  # not the one permitted sandboxed navigator. Strictly, "the rules for choosing a navigable" find the window and its
  # navigation throws a SecurityError; they leave it to the user agent whether the two "are related enough that it is
  # ok if they reach each other", and Chrome, measured, opens a new window — the tiebreak, Firefox not measured)
  context 'named by a sandboxed frame' do
    let(:path) { '/?sandbox=allow-scripts%20allow-popups' }

    include_examples 'a frame it is not found from', 1
  end
end
