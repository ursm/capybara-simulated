# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An about:blank document comes of no response (HTML makes it with no fetch): whichever way it was made, it reports 200 and
# no header, its URL — `current_url` too — about:blank, its mode quirks (HTML "create a new browsing context and
# document": mode "quirks") — the session's page before any visit and after a reset among them, the about:blank document
# a browsing context is made with (Browser::ABOUT_BLANK_RESPONSE / ABOUT_BLANK_URL, V8Runtime#init_page_realm).
RSpec.describe 'an about:blank document' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html', 'x-app' => '1'}, ['<!doctype html><meta charset=utf-8><title>t</title>']] } }
  let(:session) { simulated_session(app) }

  def reported = [session.current_url, session.status_code, session.response_headers, session.evaluate_script('[location.href, document.URL, document.contentType, document.compatMode]')]

  it 'reports no response, whichever way it was made' do
    blank = ['about:blank', 200, {}, ['about:blank', 'about:blank', 'text/html', 'BackCompat']]
    expect(reported).to eq(blank)
    session.visit '/x'
    expect(session.response_headers['X-App']).to eq('1')
    session.visit 'about:blank'
    expect(reported).to eq(blank)
    session.visit '/x'
    session.within_window(session.open_new_window) { expect(reported).to eq(blank) }
    session.reset!
    expect(reported).to eq(blank)
  end
end
