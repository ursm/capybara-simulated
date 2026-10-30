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
    session.execute_script("w.document.body.click()")
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
end
