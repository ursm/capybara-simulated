# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "follow the hyperlink" parses the link's URL as it is followed, against its node document's base URL then — a
# `<base href>` changed after the click, in the same task, changes nothing (Chrome 156 measured: `/first/x`) — and a URL
# that parses to none navigates nowhere. The engine parses it and the plan the host takes carries the URL parsed
# (dom-nodes.js `anchorActivateNavigate`).
RSpec.describe 'a hyperlink followed' do
  let(:session) do
    simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/' then '<base href="/first/"><a id=a href="x">x</a><a id=bad href="http://[bad">bad</a>'
             else "<p id=at>#{env['PATH_INFO']}</p>"
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>t</title>#{body}"]]
    })
  end

  it 'goes to its URL as the base URL was when it was followed' do
    session.visit '/'
    session.execute_script("document.getElementById('a').click(); document.querySelector('base').href = '/other/'")
    expect(session).to have_css('#at', text: '/first/x')
  end

  it 'goes nowhere where its URL parses to none' do
    session.visit '/'
    session.find('#bad').click
    expect([session.current_path, session.has_css?('#a')]).to eq(['/', true])
  end
end
