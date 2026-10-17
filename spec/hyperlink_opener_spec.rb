# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A hyperlink opening a new window opens it with an opener but where HTML "get an element's noopener" says not: its link
# types include `noopener` or `noreferrer`, or the target is `_blank` and they do not include `opener` — a named target
# keeps it. And the window loads with the opener's URL as its referrer, none under `noreferrer` (noopener alone keeps
# it). Chrome, every one.
RSpec.describe 'a hyperlink opening a window' do
  let(:app) {
    lambda do |env|
      body = if env['PATH_INFO'] == '/popup'
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

  it 'keeps the opener for a named target' do
    expect(opened('named')).to eq([true, 'http://www.example.com/'])
  end
end
