# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An `accept_*` / `dismiss_*` block answers the dialogs of the window that was current as it opened, alone — as
# Capybara's selenium driver's does, whose `switch_to.alert` finds the current window's — another window's dialog meanwhile
# taking the default policy (an alert dismissed, a confirm accepted), whichever Browser or isolate hosts it. A window the
# driver closes is the current one as it closes (selenium's `close_window` switches to it): its `beforeunload` prompt is
# the block's to answer (navigation_beforeunload_spec.rb).
RSpec.describe 'a modal block and the window its dialog is of' do
  let(:session) {
    simulated_session(lambda {|env|
      body = '<button id=c onclick="setTimeout(() => window.r = confirm(\'A?\'), 60)">c</button>'
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=\"utf-8\"><body>#{env['PATH_INFO']}#{body}"]]
    })
  }

  before { session.visit('/a') }

  it "leaves another window's dialog to the default, a Browser of its own" do
    other = session.open_new_window
    session.within_window(other) do
      session.visit('/b')
      session.execute_script("setTimeout(() => window.got = confirm('B'), 30)")
    end
    expect(session.dismiss_confirm('A?') { session.click_button('c') }).to eq('A?')
    expect(session.evaluate_script('window.r')).to be(false)
    expect(session.within_window(other) { session.evaluate_script('window.got') }).to be(true)
  end

  it "leaves a pop-up of the page's isolate's dialog to the default" do
    session.execute_script("window.w = window.open('/b'); w.setTimeout(() => w.got = w.confirm('B'), 30)")
    expect(session.dismiss_confirm('A?') { session.click_button('c') }).to eq('A?')
    expect(session.evaluate_script('[window.r, w.got]')).to eq([false, true])
  end

  it "answers the dialog of the window its block was opened in, not the window it was opened from" do
    other = session.open_new_window
    session.within_window(other) { session.visit('/b') }
    session.execute_script("setTimeout(() => window.got = confirm('A'), 30)")
    message = session.within_window(other) do
      session.dismiss_confirm { session.execute_script("setTimeout(() => window.got = confirm('B'), 80)") }
    end
    expect(message).to eq('B')
    expect(session.within_window(other) { session.evaluate_script('window.got') }).to be(false)
    expect(session.evaluate_script('window.got')).to be(true)
  end
end
