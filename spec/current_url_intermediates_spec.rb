# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The driver runs the page's event loop ahead of Capybara — a load's scripts, a poll's tick, an action's settle and the
# timers it drains — where a real browser leaves each task's result on screen until the next one. A URL the page's own
# history updates move it through on the way (pushState, replaceState, a fragment navigation) is one a polling
# `has_current_path?` sees there, so `current_url` walks the ones the page passed through as it ran, one per read; one a
# test's own script made (`execute_script`) is no step of the page's, and is read at once.
RSpec.describe 'current_url and the URLs the page passed through' do
  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
             when '/load'
               "<script>history.replaceState({}, '', '/load/a'); history.pushState({}, '', '/load/b')</script>"
             when '/turbo'
               "<button onclick=\"history.pushState({}, '', '/t1'); fetch('/data').then(r => r.text()).then(() => history.replaceState({}, '', '/t2'))\">go</button>"
             when '/chain'
               "<button onclick=\"history.pushState({}, '', '/wizard'); setTimeout(() => history.replaceState({}, '', '/wizard/steps/setup'), 30)\">go</button>"
             else
               'x'
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8><body>#{body}"]]
    end
  }
  let(:session) { simulated_session(app) }

  it "walks a load's" do
    session.visit '/load'
    expect(3.times.map { session.current_url }).to eq(%w[http://www.example.com/load http://www.example.com/load/a http://www.example.com/load/b])
  end

  # (…a timer an action set, which its settle drains: Chrome shows `/wizard` for the 30 ms before it fires)
  it "walks one an action's timer moves it through" do
    session.visit '/chain'
    session.click_button 'go'
    expect(session).to have_current_path('/wizard')
    expect(session).to have_current_path('/wizard/steps/setup')
  end

  # (…and one it moves to as an action's fetch resolves — Turbo Drive's visit: `/t1` shows until the response is in)
  it "walks one an action's fetch moves it through" do
    session.visit '/turbo'
    session.click_button 'go'
    expect(session).to have_current_path('/t1')
    expect(session).to have_current_path('/t2')
  end

  it "reads a test script's at once" do
    session.visit '/x'
    session.execute_script("history.pushState({}, '', '/one'); history.pushState({}, '', '/two')")
    expect(session.current_url).to eq('http://www.example.com/two')
  end
end
