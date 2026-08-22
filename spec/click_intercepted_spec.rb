require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# WebDriver's element-click algorithm hit-tests the target's in-view centre
# before dispatching: an unrelated element painted over it RECEIVES the click in
# a browser, so a real driver refuses with the retryable "element click
# intercepted" error and Capybara retries until the obstruction is gone. The
# driver mirrors that for FULL-COVER obstructors only (a modal backdrop, a
# page overlay) — a partial overlap is deliberately ignored because the coarse
# layout produces sibling overlaps Chrome's geometry doesn't have.
#
# The retry is what lets an in-flight async modal close (parked on its
# exit-animation timer) complete before the next click lands — without it the
# stale close's continuation tears down whatever the click just opened
# (Discourse's edit-invite modal).
RSpec.describe 'click interception' do
  def session(body)
    html = %(<html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    app  = ->(_env) { [200, {'content-type' => 'text/html'}, [html]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  it 'retries a click under a full-page overlay until the overlay goes away' do
    s = session(<<~HTML)
      <button id="btn" onclick="window.__clicked = true">go</button>
      <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
      <script>setTimeout(() => document.getElementById('overlay').remove(), 400);</script>
    HTML
    s.find('#btn').click
    expect(s.evaluate_script('window.__clicked')).to be true
  end

  it 'fails with the intercepted error when the overlay never leaves' do
    s = session(<<~HTML)
      <button id="btn" onclick="window.__clicked = true">go</button>
      <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
    HTML
    expect {
      s.using_wait_time(0.3) { s.find('#btn').click }
    }.to raise_error(Capybara::Simulated::ClickIntercepted, /other element would receive the click: <div id="overlay"/)
    expect(s.evaluate_script('window.__clicked')).to be_nil
  end

  it 'does not treat a partially overlapping sibling as an obstruction' do
    s = session(<<~HTML)
      <div style="position:relative">
        <button id="btn" onclick="window.__clicked = true" style="width:100px;height:30px">go</button>
        <span style="position:absolute;left:45px;top:10px;width:12px;height:12px">x</span>
      </div>
    HTML
    s.find('#btn').click
    expect(s.evaluate_script('window.__clicked')).to be true
  end

  it 'lets a descendant receive its own container click' do
    s = session(<<~HTML)
      <button id="btn" onclick="window.__clicked = true" style="width:100px;height:30px">
        <svg id="icon" width="100" height="30"></svg>
      </button>
    HTML
    s.find('#btn').click
    expect(s.evaluate_script('window.__clicked')).to be true
  end
end
