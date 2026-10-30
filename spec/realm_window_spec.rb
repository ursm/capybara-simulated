require 'capybara/simulated'
require_relative 'support/session_teardown'

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
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>posted</title></head><body><p id=\"posted\">#{env['REQUEST_METHOD']} #{env['rack.input'].read}</p></body></html>"
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

  it 'closes with the window that hosts it, its document unloaded' do
    host = session.open_new_window
    session.within_window(host) do
      session.visit('/')
      session.execute_script("window.w = window.open(); w.onunload = () => localStorage.setItem('unloaded', '1');")
    end
    expect(session.windows.size).to eq(3)
    host.close
    expect(session.windows.size).to eq(1)
    expect(session.evaluate_script("localStorage.getItem('unloaded')")).to eq('1')
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
