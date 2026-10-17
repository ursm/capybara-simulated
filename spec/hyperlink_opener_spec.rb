# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A hyperlink opening a new window opens it with an opener but where HTML "get an element's noopener" says not: its link
# types include `noopener` or `noreferrer`, or the target is `_blank` and they do not include `opener` — a named target
# keeps it — in the target it names, else its document's `<base target>`. And the window loads with its document's URL as
# its referrer, none under `noreferrer` (noopener alone keeps it). Chrome, every one.
RSpec.describe 'a hyperlink opening a window' do
  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
      when '/based'
        <<~HTML
          <!doctype html><meta charset="utf-8"><title>based</title><base target="_blank">
          <a id="based" href="/popup">based</a> <a id="own" href="/popup" target="">own empty target</a>
        HTML
      when '/framed'
        <<~HTML
          <!doctype html><meta charset="utf-8"><title>framed</title>
          <iframe name="f" srcdoc='<a id="inner" href="/popup" target="_blank" rel="opener">inner</a>'></iframe>
        HTML
      when '/popup'
        <<~HTML
          <!doctype html><meta charset="utf-8"><title>popup</title>
          <p id="r"></p><script>document.getElementById('r').textContent = JSON.stringify([!!window.opener, document.referrer]);</script>
        HTML
      else
        <<~HTML
          <!doctype html><meta charset="utf-8"><title>main</title>
          <a id="blank" href="/popup" target="_blank">blank</a>
          <a id="blank-opener" href="/popup" target="_blank" rel="opener">blank opener</a>
          <a id="no-referrer" href="/popup" target="_blank" rel="opener noreferrer">opener noreferrer</a>
          <a id="named" href="/popup" target="named">named</a>
        HTML
      end
      [200, {'content-type' => 'text/html'}, [body]]
    end
  }

  def opened(id)
    session = simulated_session(app)
    session.visit '/'
    window = session.window_opened_by { session.click_link(id) }
    session.within_window(window) { JSON.parse(session.find('#r').text) }
  end

  it 'opens `_blank` with no opener, but for `rel=opener`, and with the referrer' do
    expect(opened('blank')).to eq([false, 'http://www.example.com/'])
    expect(opened('blank-opener')).to eq([true, 'http://www.example.com/'])
  end

  it 'opens with neither an opener nor a referrer under `noreferrer`, `opener` or not' do
    expect(opened('no-referrer')).to eq([false, ''])
  end

  # (…the window is the name's — the next link of it navigates that one — though its `window.name` is not yet: a top-level
  # browsing context's name is the host's to keep across its loads, which no window opened as a Browser of its own does)
  it 'keeps the opener for a named target, and navigates that window the next time' do
    expect(opened('named')).to eq([true, 'http://www.example.com/'])
    session = simulated_session(app)
    session.visit '/'
    session.window_opened_by { session.click_link('named') }
    session.click_link('named')
    expect(session.windows.size).to eq(2)
  end

  it 'opens the same from a script-initiated click' do
    session = simulated_session(app)
    session.visit '/'
    window = session.window_opened_by { session.execute_script("document.getElementById('named').click()") }
    expect(session.within_window(window) { JSON.parse(session.find('#r').text) }).to eq([true, 'http://www.example.com/'])
  end

  it "opens in the document's `<base target>` where the link names none of its own" do
    session = simulated_session(app)
    session.visit '/based'
    window = session.window_opened_by { session.click_link('based') }
    expect(session.within_window(window) { JSON.parse(session.find('#r').text) }).to eq([false, 'http://www.example.com/based'])
    session.click_link('own')
    expect([session.windows.size, session.current_path]).to eq([2, '/popup'])
  end

  it "loads with a frame's link's referrer the frame's document's — a srcdoc one's its container's" do
    session = simulated_session(app)
    session.visit '/framed'
    window = session.window_opened_by { session.within_frame('f') { session.click_link('inner') } }
    expect(session.within_window(window) { JSON.parse(session.find('#r').text) }).to eq([true, 'http://www.example.com/framed'])
  end
end
