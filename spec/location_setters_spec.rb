# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Location's setters (HTML §7.2.4) set a part of a copy of the document's URL and navigate there — the engine's
# (url_ops.rs `location_set`): `protocol` a scheme or a SyntaxError, `search` a query percent-encoded in the document's
# encoding (where Chrome 154 takes UTF-8 — HTML step 5.3 names "the relevant Document's document's character
# encoding"), and `hash` none where the fragment comes out what it was, a null one the empty string.
RSpec.describe 'Location setters' do
  let(:session) {
    simulated_session(lambda {|env|
      charset = env['PATH_INFO'] == '/legacy' ? 'windows-1252' : 'utf-8'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=#{charset}><body>"]]
    })
  }

  it 'navigates to the URL a setter makes of its copy, or refuses' do
    session.visit '/legacy'
    expect(session.evaluate_script(<<~JS)).to eq(['SyntaxError', "Failed to set the 'protocol' property on 'Location': 'a b' is an invalid protocol.", '/legacy'])
      (() => { try { location.protocol = 'a b'; } catch (e) { return [e.name, e.message, location.pathname]; } })()
    JS
    session.execute_script("location.hash = ''")
    expect(session.evaluate_script('location.href')).to end_with('/legacy')
    session.execute_script("location.search = '\\u00e9 \\tx\\n'")
    expect(session.current_url).to end_with('/legacy?%E9%20x')
  end
end
