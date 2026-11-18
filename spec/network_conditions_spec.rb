# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# The network a test's CDP stand-in emulates is the browser's (Browser#online=, #slow_uploads=), as Chrome's
# `Network.emulateNetworkConditions` is the page target's whatever document it shows: every realm reads it — the page's,
# a frame's, a worker's, and those made after it changed, the next document's among them — and every live one is told as
# it changes, its `online` / `offline` fired at its global.
RSpec.describe 'the network conditions a test emulates' do
  let(:posts) { [] }
  let(:app) {
    posts = self.posts
    lambda do |env|
      if env['REQUEST_METHOD'] == 'POST'
        posts << env['PATH_INFO']
        next [200, {'content-type' => 'text/plain'}, ['ok']]
      end
      body = case env['PATH_INFO']
             when '/w.js' then "postMessage(navigator.onLine); addEventListener('offline', () => postMessage('offline')); addEventListener('online', () => postMessage('online'));"
             else '<!DOCTYPE html><meta charset=utf-8><body><iframe id=f srcdoc="<p>x"></iframe>'
             end
      [200, {'content-type' => env['PATH_INFO'].end_with?('.js') ? 'text/javascript' : 'text/html'}, [body]]
    end
  }
  let(:session) { simulated_session(app) }
  let(:browser) { session.driver.browser }

  def frame_eval(js) = session.evaluate_script("document.getElementById('f').contentWindow.eval(#{js.to_json})")

  it 'takes every realm off line and back, the ones made since too' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.seen = [];
      addEventListener('offline', () => seen.push('page offline'));
      addEventListener('online', () => seen.push('page online'));
      document.getElementById('f').contentWindow.addEventListener('offline', () => seen.push('frame offline'));
      window.heard = [];
      new Worker('/w.js').onmessage = (e) => heard.push(e.data);
    JS
    expect(poll_until { session.evaluate_script('heard.length') }).to eq(1)
    browser.online = false
    expect(session.evaluate_script('[navigator.onLine, seen]')).to eq([false, ['page offline', 'frame offline']])
    expect(frame_eval('navigator.onLine')).to be(false)
    poll_until { session.evaluate_script('heard.length') > 1 }
    expect(session.evaluate_script('heard')).to eq([true, 'offline'])
    session.execute_script("window.late = []; new Worker('/w.js').onmessage = (e) => late.push(e.data);")
    poll_until { session.evaluate_script('late.length') > 0 }
    expect(session.evaluate_script('late')).to eq([false])
    session.visit '/'
    expect(session.evaluate_script('navigator.onLine')).to be(false)
    expect(frame_eval('navigator.onLine')).to be(false)
    session.execute_script("window.seen = []; addEventListener('online', () => seen.push('page online'));")
    browser.online = true
    expect(session.evaluate_script('[navigator.onLine, seen]')).to eq([true, ['page online']])
  end

  it "holds every realm's uploads until they are let go, the next document's too" do
    session.visit '/'
    browser.slow_uploads = true
    session.execute_script("const x = new XMLHttpRequest(); x.open('POST', '/page'); x.send('a');")
    frame_eval("const x = new XMLHttpRequest(); x.open('POST', '/frame'); x.send('a');")
    session.evaluate_script('1')
    expect(posts).to eq([])
    browser.slow_uploads = false
    poll_until { session.evaluate_script('1') && posts.size > 1 }
    expect(posts.sort).to eq(%w[/frame /page])
    browser.slow_uploads = true
    session.visit '/'
    session.execute_script("const x = new XMLHttpRequest(); x.open('POST', '/next'); x.send('a');")
    session.evaluate_script('1')
    expect(posts).not_to include('/next')
    browser.slow_uploads = false
    expect(poll_until { session.evaluate_script('1') && posts.include?('/next') }).to be(true)
  end
end
