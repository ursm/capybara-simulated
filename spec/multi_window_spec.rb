require 'capybara/simulated'
require 'rusty_racer' if (ENV['CSIM_JS_ENGINE'].to_s.empty? ? Gem.loaded_specs.key?('rusty_racer') : ENV['CSIM_JS_ENGINE'] == 'v8')
require_relative 'support/js_engine'

# Full multi-window: each window/tab is its own Browser + JS VM (own DOM,
# sessionStorage, history; cookies + localStorage shared). On top of the
# window-handle plumbing, JS `window.open` opens a real auxiliary window,
# `window.opener` points back to the opener, and `postMessage` crosses the
# window boundary (routed through the Driver — windows are separate isolates).
RSpec.describe 'multi-window' do
  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
      when '/'
        <<~HTML
          <!doctype html><html><head><title>main</title></head><body>
            <h1 id="main">MAIN</h1>
            <button id="open" onclick="window.popup = window.open('/popup', 'pop')">open</button>
            <button id="post" onclick="window.popup && window.popup.postMessage('ping', '*')">post</button>
            <script>
              window.addEventListener('message', e => { document.title = 'MAIN_GOT:' + e.data; });
              window.transferBufferToPopup = function () {
                const buf = new Uint8Array([2, 4, 6, 8]).buffer;   // sum 20
                window.popup.postMessage(buf, '*', [buf]);          // TRANSFER (zero-copy)
                return buf.byteLength;                              // 0 if detached
              };
            </script>
          </body></html>
        HTML
      when '/popup'
        <<~HTML
          <!doctype html><html><head><title>popup</title></head><body>
            <h1 id="pop">POPUP</h1>
            <button id="back" onclick="window.opener && window.opener.postMessage('pong','*')">reply</button>
            <script>
              if (window.opener) { var d = document.createElement('div'); d.id = 'has-opener'; document.body.appendChild(d); }
              window.addEventListener('message', e => {
                if (e.data instanceof ArrayBuffer) {
                  const b = new Uint8Array(e.data);
                  document.title = 'POPUP_BUF:' + b.reduce((a, x) => a + x, 0) + '/' + b.length;
                } else {
                  document.title = 'POPUP_GOT:' + e.data;
                }
              });
            </script>
          </body></html>
        HTML
      else
        '<!doctype html><html><body><div id="other">OTHER</div></body></html>'
      end
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit('/') }
  # Reset between examples (these are ad-hoc sessions Capybara doesn't auto-reset)
  # so the PROCESS-WIDE transfer registry doesn't carry a parked token from a
  # transfer whose target never imported it into the next example's leak canary.
  after { session.reset_session! }

  it 'open_new_window gives an about:blank window with its own DOM' do
    win = session.open_new_window
    session.within_window(win) do
      expect(session.current_url).to eq('about:blank')
      session.visit('/popup')
      expect(session).to have_css('#pop', text: 'POPUP')
    end
    expect(session).to have_css('#main')
  end

  it 'window_opened_by captures a target=_blank style open via window.open' do
    win = session.window_opened_by { session.find(:css, '#open').click }
    expect(win).to be_a(Capybara::Window)
    session.within_window(win) do
      expect(session).to have_css('#pop')
      expect(session.current_url).to end_with('/popup')
    end
  end

  it 'sets window.opener on a JS-opened window' do
    win = session.window_opened_by { session.find(:css, '#open').click }
    session.within_window(win) do
      expect(session).to have_css('#has-opener')   # added only when window.opener is truthy
    end
  end

  it 'delivers postMessage from opener to the opened window' do
    win = session.window_opened_by { session.find(:css, '#open').click }
    session.find(:css, '#post').click
    session.within_window(win) do
      expect(session).to have_title('POPUP_GOT:ping')
    end
  end

  it 'delivers postMessage from the opened window back to the opener (window.opener.postMessage)' do
    win = session.window_opened_by { session.find(:css, '#open').click }
    session.within_window(win) { session.find(:css, '#back').click }
    expect(session).to have_title('MAIN_GOT:pong')
  end

  it 'reuses a window by name (second window.open with the same name navigates it)' do
    session.find(:css, '#open').click
    opened = session.windows.size
    # Re-opening the same name must not create a third window.
    session.execute_script("window.open('/other', 'pop')")
    expect(session.windows.size).to eq(opened)
  end

  # postMessage transfer semantics: the listed ArrayBuffer is detached on the
  # sender (observable half of transfer; the bytes are still copied). V8 has
  # `ArrayBuffer.prototype.transfer`; QuickJS has no JS-level detach.
  it 'detaches a transferred ArrayBuffer on the sender', if: CsimEngine.v8? do
    session.window_opened_by { session.find(:css, '#open').click }
    detached = session.evaluate_script(<<~JS)
      (() => {
        const buf = new Uint8Array([1, 2, 3, 4]).buffer;
        window.popup.postMessage(buf, '*', [buf]);
        return buf.byteLength === 0 && buf.detached === true;
      })()
    JS
    expect(detached).to be(true)
  end

  # Zero-copy transfer across windows: a buffer in the transfer list moves its
  # backing store by token (no copy), detaching the source; the target rebuilds
  # it. V8 only (the transfer registry is a rusty_racer feature).
  it 'transfers a buffer zero-copy to another window', if: CsimEngine.v8? do
    win = session.window_opened_by { session.find(:css, '#open').click }
    src_len_after = session.evaluate_script('window.transferBufferToPopup()')
    expect(src_len_after).to eq(0)                       # source detached by the transfer
    session.within_window(win) do
      expect(session).to have_title('POPUP_BUF:20/4')    # bytes arrived intact
    end
    expect(RustyRacer.pending_transfer_count).to eq(0)   # imported → no parked store
  end

  it 'reports window.closed after the window is closed' do
    win = session.window_opened_by { session.find(:css, '#open').click }
    win.close
    expect(session.evaluate_script('!window.popup || window.popup.closed')).to be(true)
  end
end
