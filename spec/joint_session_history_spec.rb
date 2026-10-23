# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The page's session history is ONE joint history of it and its frames (HTML §7.4.1, session_history.rs): a frame's
# navigation is a step of the page's — its `history.length` one more — and a traversal by a step, whichever navigable's
# `history` asks for it, moves whichever navigable's entry the step is. Chrome, measured 2026-10-24 (a page at /top
# with a frame at /f1, after the page's load):
#   frame to /f2         → length 2
#   page's back          → the frame at /f1, the page staying
#   page's forward       → the frame at /f2
#   frame's back         → the frame at /f1
#   frame's pushState    → length 2 (the forward step dropped)
#   page's pushState     → length 3
#   back                 → the page's popstate, at /top again, the frame staying
#   back                 → the frame back to /f1, same-document
RSpec.describe 'the joint session history' do
  let(:app) do
    lambda {|env|
      body = case env['PATH_INFO']
             when '/top' then '<iframe src="/f1"></iframe><script>addEventListener("popstate", () => document.title += "P")</script>'
             when '/f1' then 'F1<script>addEventListener("popstate", () => parent.document.title += "F")</script>'
             when '/f2' then 'F2'
             when '/b' then 'B'
             else 'START'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    }
  end
  let(:session) { simulated_session(app) }

  def frame_path = session.evaluate_script('frames[0].location.pathname')
  def length = session.evaluate_script('history.length')

  it "counts a frame's navigation a step of the page's" do
    session.visit '/top'
    expect(length).to eq(1)
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    expect(length).to eq(2)
  end

  it "takes the frame back on the page's back and forth on its forward" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.execute_script('history.back()')
    expect(frame_path).to eq('/f1')
    expect(session.current_path).to eq('/top')
    session.execute_script('history.forward()')
    expect(frame_path).to eq('/f2')
    session.execute_script('frames[0].history.back()')
    expect(frame_path).to eq('/f1')
    expect(length).to eq(2)
  end

  it 'takes the frame back on the session going back' do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.go_back
    expect(frame_path).to eq('/f1')
    expect(session.current_path).to eq('/top')
    session.go_forward
    expect(frame_path).to eq('/f2')
  end

  it "steps through the page's pushState and the frame's in the order they were made" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.execute_script('history.back()')
    expect(frame_path).to eq('/f1')
    session.execute_script('frames[0].history.pushState(null, "", "/f1x")')
    expect(length).to eq(2)
    session.execute_script('history.pushState(null, "", "/topx")')
    expect(length).to eq(3)
    session.execute_script('history.back()')
    expect(session.current_path).to eq('/top')
    expect(frame_path).to eq('/f1x')
    session.execute_script('history.back()')
    expect(frame_path).to eq('/f1')
    expect(session.evaluate_script('document.title')).to eq('PF')
  end

  # The page navigated on: its frames' steps stay steps of the document it left (Chrome: 3 after /b), and a traversal
  # back to it makes it again, its frames with it.
  it "keeps a frame's steps once the page has navigated on" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(frame_path).to eq('/f2')
    session.visit '/b'
    expect(length).to eq(3)
    session.go_back
    expect(session.current_path).to eq('/top')
  end
end
