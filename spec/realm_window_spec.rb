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
end
