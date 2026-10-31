require 'capybara/simulated'
require 'rusty_racer'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A message's `source` is the WindowProxy of the incumbent settings object's global — the realm whose script called
# `postMessage` (HTML "window post message steps" 8) — whichever realm holds the WindowProxy it was called on: a frame
# posting through a reference its page keeps posts as the frame, not as the page (B10). The bindings' `postMessage` is
# the engine's `withIncumbent` bound to its steps, which V8's incumbent context answers.
RSpec.describe "a message's source" do
  include PollUntil

  let(:app) {
    lambda do |env|
      body = case env['PATH_INFO']
             when '/frame' then "<script>window.up = () => parent.postMessage('up', '*'); window.over = () => top.w.postMessage('over', '*'); window.across = () => top.frames[1].postMessage('across', '*');</script>"
             when '/popup' then '<script>window.got = []; onmessage = (e) => got.push([e.data, e.source === opener.frames[0], e.source === opener]);</script>'
             when '/sibling' then '<script>window.got = []; onmessage = (e) => got.push([e.data, e.source === parent.frames[0], e.source === parent]);</script>'
             else '<script>window.got = []; onmessage = (e) => got.push([e.data, e.source === frames[0], e.source === window]);</script><iframe src=/frame></iframe><iframe src=/sibling></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!doctype html><meta charset=utf-8>#{body}"]]
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit 'http://a.test/page' }

  it 'is the frame whose script posted through a WindowProxy its page holds' do
    session.execute_script("window.w = open('/popup')")
    poll_until { session.evaluate_script('w.document.readyState') == 'complete' }
    session.execute_script('frames[0].up(); frames[0].over(); frames[0].across()')
    poll_until { session.evaluate_script('got.length + w.got.length + frames[1].got.length') == 3 }

    expect(session.evaluate_script('got')).to eq([['up', true, false]])
    expect(session.evaluate_script('w.got')).to eq([['over', true, false]])
    expect(session.evaluate_script('frames[1].got')).to eq([['across', true, false]])
  end

  it 'is the page whose own script posted through the same WindowProxy' do
    session.execute_script("window.w = open('/popup')")
    poll_until { session.evaluate_script('w.document.readyState') == 'complete' }
    session.execute_script("w.postMessage('own', '*')")
    poll_until { session.evaluate_script('w.got.length') == 1 }

    expect(session.evaluate_script('w.got')).to eq([['own', false, true]])
  end
end
