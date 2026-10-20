# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `window.open()` and `sendBeacon()` parse their URL against the API base URL of the document whose method it is: a
# frame's own `window.open('p.html')` opens the page beside the frame's document, and a `data:` frame's relative beacon
# URL — no URL against its opaque base — is a TypeError.
RSpec.describe 'the URL base of window.open and sendBeacon' do
  let(:app) {
    # (…a `data:` frame is of an opaque origin: it reports what its beacon did by message)
    beacon = 'data:text/html,<script>let r = "none"; try { navigator.sendBeacon("foo"); } catch (e) { r = e.name; } parent.postMessage(r, "*");</script>'
    top = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <script>addEventListener('message', (e) => { window.__beacon = e.data; });</script>
      <iframe src="/sub/f.html"></iframe><iframe src='#{beacon}'></iframe>
    HTML
    lambda {|env|
      body = case env['PATH_INFO']
             when '/'           then top
             when '/sub/f.html' then '<!DOCTYPE html><meta charset="utf-8">frame'
             else '<!DOCTYPE html><meta charset="utf-8">opened'
             end
      [200, {'content-type' => 'text/html'}, [body]]
    }
  }

  it 'opens a frame’s relative URL beside the frame, and refuses a data: frame’s relative beacon' do
    s = simulated_session(app)
    s.visit '/'
    s.document.synchronize { s.evaluate_script('window.__beacon') or raise Capybara::ExpectationNotMet }
    expect(s.evaluate_script('window.__beacon')).to eq('TypeError')
    s.execute_script('frames[0].open("p.html", "w")')
    s.within_window(s.windows.last) { expect(s.current_url).to end_with('/sub/p.html') }
  end
end
