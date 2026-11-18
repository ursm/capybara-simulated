# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A navigation and a close ask the document they would unload first (HTML "navigate" and "definitely close": "check if
# unloading is canceled"), as a traversal does: a `beforeunload` that cancels the event, of a document with sticky
# activation, asks the user to confirm, and the navigation is aborted — the close not made — where the user declines,
# the driver's dialog policy the user: confirmed, but in a `dismiss_confirm` block. Chrome 157, measured 2026-11-19
# (Playwright, a click on the page first): a link, `location.href =`, a form's submission, a frame's `src` its parent set
# and a typed URL (`page.goto`) each prompt, go on accepted and stay dismissed; a pop-up's `window.close()` prompts too,
# its window open still where dismissed and `closed` false again (HTML leaves "is closing" set: whatwg/html#12969).
RSpec.describe 'a navigation, a close and beforeunload' do
  let(:session) {
    simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/a'
               <<~HTML
                 <a id=link href="/b">link</a> <button id=loc onclick="location.href = '/b'">loc</button>
                 <form action="/b"><button id=sub>sub</button></form> <button id=touch>touch</button>
                 <button id=framenav onclick="document.querySelector('iframe').src = '/b'">framenav</button>
                 <button id=pop onclick="window.w = window.open('/a')">pop</button>
                 <button id=closeme onclick="window.close()">closeme</button>
                 <iframe src="/child"></iframe>
                 <script>addEventListener('beforeunload', (e) => e.preventDefault());</script>
               HTML
             when '/child' then "child<script>addEventListener('beforeunload', (e) => e.preventDefault());</script>"
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=\"utf-8\"><body>#{body}"]]
    })
  }

  before { session.visit('/a') }

  def frame_path = session.evaluate_script('frames[0].location.pathname')

  %w[link loc sub].each do |id|
    it "aborts a #{id}'s navigation the user declines, and makes one confirmed" do
      session.dismiss_confirm { session.click_on(id) }
      expect(session.current_path).to eq('/a')
      session.accept_confirm { session.click_on(id) }
      expect(session).to have_current_path(%r{\A/b})
    end
  end

  it "aborts a typed URL's the user declines, and asks nothing a test did not ask about" do
    session.click_on('touch')
    session.dismiss_confirm { session.visit('/c') }
    expect(session.current_path).to eq('/a')
    session.visit('/c')
    expect(session.current_path).to eq('/c')
  end

  it 'asks nothing of a document with no sticky activation' do
    session.execute_script("location.href = '/b'")
    expect(session).to have_current_path('/b')
  end

  it "aborts a frame's its parent began the user declines, the frame working on" do
    session.dismiss_confirm { session.click_on('framenav') }
    expect(frame_path).to eq('/child')
    session.accept_confirm { session.click_on('framenav') }
    expect(frame_path).to eq('/b')
    session.execute_script("frames[0].location = '/c'")
    expect(frame_path).to eq('/c')
  end

  it "keeps a pop-up open whose close the user declines" do
    session.click_on('pop')
    popup = session.windows.last
    session.execute_script('w.focus()')
    focused = -> { [session.evaluate_script('document.hasFocus()'), session.within_window(popup) { session.evaluate_script('document.hasFocus()') }] }
    expect(focused.call).to eq([false, true])
    session.within_window(popup) do
      session.dismiss_confirm { session.click_on('closeme') }
      expect(session).to have_button('closeme')
    end
    # (…the system focus the pop-up's still, as Chrome keeps it — the close's move of it to the page taken back)
    expect(focused.call).to eq([false, true])
    expect(session.windows.size).to eq(2)
    expect(session.evaluate_script('w.closed')).to be(false)
    session.within_window(popup) { session.accept_confirm { session.click_on('closeme') } }
    expect(session.windows.size).to eq(1)
    # (…and, the close made, the system focus its opener's)
    expect(session.evaluate_script('document.hasFocus()')).to be(true)
  end

  # Focus leaves a window as its close is made, not as `close()` is asked (HTML: `close()` queues "definitely close",
  # the focus going with the navigable destroyed): a pop-up closing keeps it until then, and gives it to its opener's
  # window — a pop-up's that opened it, open still — not to the page.
  it 'moves the focus as the close is made, to the opener' do
    session.execute_script("window.w = window.open('/c')")
    session.execute_script("window.w2 = w.open('/d'); w2.focus()")
    expect(session.evaluate_script('[document.hasFocus(), w.document.hasFocus(), w2.document.hasFocus()]')).to eq([false, false, true])
    expect(session.evaluate_script('w2.close(); [w2.closed, w2.document.hasFocus()]')).to eq([true, true])
    expect(session.evaluate_script('[document.hasFocus(), w.document.hasFocus()]')).to eq([false, true])
  end

  it "keeps a window open the driver's close the user declines" do
    session.click_on('pop')
    popup = session.windows.last
    session.within_window(popup) { session.click_on('touch') }
    session.dismiss_confirm { popup.close }
    expect(session.windows.size).to eq(2)
    popup.close
    expect(session.windows.size).to eq(1)
  end

  # …a window of a browsing context group of its own (a `noopener` one, a Browser of its own) the same way.
  it "keeps a noopener window open whose close the user declines" do
    session.execute_script("window.open('/a', '_blank', 'noopener')")
    popup = session.windows.last
    session.within_window(popup) do
      expect(session).to have_button('closeme')
      session.dismiss_confirm { session.click_on('closeme') }
      expect(session.evaluate_script('window.closed')).to be(false)
    end
    expect(session.windows.size).to eq(2)
    session.within_window(popup) { session.accept_confirm { session.click_on('closeme') } }
    expect(session.windows.size).to eq(1)
  end

  # …and a window of the session's other than the current one, a Browser of its own, its prompt answered by the block
  # the close was asked in: the session's handlers, whichever window raises the dialog.
  it "answers another window's prompt by the block its close was asked in" do
    other = session.open_new_window
    session.within_window(other) do
      session.visit('/a')
      session.click_on('touch')
    end
    session.dismiss_confirm { other.close }
    expect(session.windows.size).to eq(2)
    expect(other.closed?).to be(false)
  end
end
