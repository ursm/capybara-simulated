# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A link whose target names a window the page opened chooses that window's navigable (HTML "the rules for choosing a
# navigable": another top-level traversable of its browsing context group) and navigates it — no new window opened,
# the page staying where it is.
RSpec.describe 'a link naming a window the page opened' do
  include PollUntil

  it 'navigates that window' do
    session = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/' ? '<a id=go href="/landed" target=pop>go</a>' : "<p>#{env['PATH_INFO']}</p>"
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>main</title><body>#{body}"]]
    })
    session.visit '/'
    # (…an about:blank one, which this isolate makes a realm of: its document scriptable from here)
    session.execute_script("window.popup = open('', 'pop')")
    windows = session.windows.size
    session.execute_script("document.getElementById('go').click()")
    expect(poll_until { session.evaluate_script('popup.location.pathname') == '/landed' && [session.windows.size, session.current_path] }).to eq([windows, '/'])
  end

  # …under the referrer policy its `rel` / `referrerpolicy` sets: none sent for `rel=noreferrer`.
  it 'sends the Referer its link types say' do
    referers = {}
    session = simulated_session(lambda {|env|
      referers[env['PATH_INFO']] = env['HTTP_REFERER']
      body = env['PATH_INFO'] == '/' ? '<a id=nr href="/nr" target=pop rel=noreferrer>nr</a><a id=o href="/o" target=pop referrerpolicy=origin>o</a>' : 'x'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/?q=1'
    session.execute_script("window.popup = open('', 'pop')")
    session.execute_script("document.getElementById('nr').click()")
    poll_until { session.evaluate_script('popup.location.pathname') == '/nr' }
    session.execute_script("document.getElementById('o').click()")
    poll_until { session.evaluate_script('popup.location.pathname') == '/o' }
    expect([referers['/nr'], referers['/o']]).to eq([nil, 'http://www.example.com/'])
  end
end
