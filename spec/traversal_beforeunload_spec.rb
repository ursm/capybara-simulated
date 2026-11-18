# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A traversal asks the document it would unload first (HTML "apply the history step": "check if unloading is canceled"):
# a `beforeunload` that cancels the event, of a document with sticky activation, asks the user to confirm, and the step
# is aborted where the user declines — the driver's dialog policy the user: confirmed, but in a `dismiss_confirm` block.
# Chrome 157, measured 2026-11-19 (Playwright, a click on the page first): `history.back()` and the browser's back both
# prompt; accepted, the traversal goes on; dismissed, the page stays. With no activation no prompt is shown.
RSpec.describe 'a traversal and beforeunload' do
  TRAVERSAL_BEFOREUNLOAD_FRAMES = {
    '/two' => '<button id=touch>touch</button><iframe id=f1 src="/ia"></iframe><iframe id=f2 src="/ia"></iframe>',
    '/ia'  => '<p>ia</p><script>addEventListener("beforeunload", (e) => { e.preventDefault(); top.count++; })</script>',
    '/ib'  => '<p>ib</p><script>addEventListener("beforeunload", (e) => { e.preventDefault(); top.count++; })</script>'
  }.freeze

  let(:session) {
    simulated_session(lambda {|env|
      body = TRAVERSAL_BEFOREUNLOAD_FRAMES[env['PATH_INFO']] || (env['PATH_INFO'] == '/b' ? <<~HTML : env['PATH_INFO'])
        <button id=back onclick="history.back()">back</button><button id=touch>touch</button>
        <iframe src="/inner"></iframe>
        <script>addEventListener('beforeunload', (e) => { e.preventDefault(); window.asked = (window.asked || 0) + 1; });</script>
      HTML
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=\"utf-8\"><body>#{body}"]]
    })
  }

  before do
    session.visit('/a')
    session.visit('/b')
  end

  it "stays where the user declines a script's traversal" do
    session.dismiss_confirm { session.click_button('back') }
    expect(session.current_path).to eq('/b')
    expect(session.evaluate_script('window.asked')).to eq(1)
  end

  it "stays where the user declines the driver's own back" do
    session.click_button('touch')
    session.dismiss_confirm { session.go_back }
    expect(session.current_path).to eq('/b')
  end

  it 'goes on where the user confirms' do
    session.accept_confirm { session.click_button('back') }
    expect(session.current_path).to eq('/a')
  end

  it 'asks nothing of a document with no sticky activation' do
    session.go_back
    expect(session.current_path).to eq('/a')
  end

  # …and a frame's document asked: the step aborted for every navigable it moves.
  it "stays where the user declines a frame's traversal" do
    session.within_frame(0) do
      session.execute_script("history.pushState(null, '', '/inner2')")
      session.execute_script("addEventListener('beforeunload', (e) => e.preventDefault())")
    end
    session.execute_script("frames[0].location = '/inner3'")
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/inner3')
    session.within_frame(0) do
      session.execute_script("addEventListener('beforeunload', (e) => e.preventDefault())")
      session.execute_script("document.body.innerHTML = '<button id=t>t</button>'")
      session.click_button('t')
    end
    session.dismiss_confirm { session.go_back }
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/inner3')
    session.go_back
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/inner2')
  end

  # …and a window's `window.open` made in this isolate, as the page's: asked, and aborted; confirmed, made again with
  # its controls' state.
  it "stays where the user declines a window's traversal, and goes on where confirmed" do
    session.execute_script("window.w = open('/a')")
    popup = session.windows.last
    session.execute_script("w.location = '/b'")
    session.within_window(popup) do
      expect(session).to have_button('back')
      session.dismiss_confirm { session.click_button('back') }
      expect(session.current_path).to eq('/b')
      session.accept_confirm { session.click_button('back') }
      expect(session).to have_no_button('back')
      expect(session.current_path).to eq('/a')
    end
  end

  # …one check over every document the step unloads, its frames' each: the user asked once (HTML "check if unloading
  # is canceled", `unloadPromptShown`), every one's `beforeunload` fired.
  it 'asks the user once for all the frames a traversal moves' do
    modals = []
    session.visit('/two')
    session.execute_script("document.getElementById('f1').src = '/ib'; document.getElementById('f2').src = '/ib'")
    expect(session.evaluate_script("[f1.contentWindow.location.pathname, f2.contentWindow.location.pathname]")).to eq(%w[/ib /ib])
    session.click_button('touch')
    session.execute_script('top.count = 0')
    browser = session.driver.browser
    browser.define_singleton_method(:handle_modal) {|type, *rest| modals << type; super(type, *rest) }
    session.dismiss_confirm { session.execute_script('history.go(-2)') }
    expect(modals).to eq(['beforeunload'])
    expect(session.evaluate_script('[top.count, f1.contentWindow.location.pathname, f2.contentWindow.location.pathname]')).to eq([2, '/ib', '/ib'])
  end
end
