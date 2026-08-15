# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The sendBeacon synchronization contract analytics libraries (Ahoy.js, Segment)
# ride on: a beacon POSTed from a click handler is visible to the assertion that
# follows the click — no sleep, no retry. sendBeacon routes through fetch()'s
# keepalive path (eager dispatch inside the call, drained by the settle loop), so
# this spec is the barrier that keeps that path synchronously observable
# (feedback_async_absence_needs_barrier).
RSpec.describe 'navigator.sendBeacon' do
  let(:beacons) { [] }

  let(:app) {
    received = beacons
    Rack::Builder.new {
      run lambda {|env|
        req = Rack::Request.new(env)
        case req.path_info
        when '/beacon'
          received << req.body.read
          [204, {}, []]
        else
          [200, {'content-type' => 'text/html'}, [<<~HTML]]
            <html><body>
              <button id="go">go</button>
              <script>
                document.getElementById('go').addEventListener('click', () => {
                  navigator.sendBeacon('/beacon', 'clicked-payload');
                });
              </script>
            </body></html>
          HTML
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  it 'delivers a click-handler beacon before the next assertion' do
    session = simulated_session(app)
    session.visit '/'
    session.click_button 'go'
    expect(beacons).to eq(['clicked-payload'])
  end

  it 'returns true and delivers a beacon sent from evaluate_script' do
    session = simulated_session(app)
    session.visit '/'
    expect(session.evaluate_script("navigator.sendBeacon('/beacon', 'direct')")).to be true
    # A bare evaluate_script runs no settle loop afterwards, so the detached
    # keepalive dispatch is only EVENTUALLY visible here (the synchronous
    # contract above is click-shaped: settle drains it before the assertion).
    deadline = Time.now + 2
    sleep 0.01 until beacons.any? || Time.now > deadline
    expect(beacons).to eq(['direct'])
  end

  it 'throws a TypeError synchronously for an unparseable URL' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      (() => { try { navigator.sendBeacon('https://:bad'); return 'no-throw'; } catch (e) { return e.constructor.name; } })()
    JS
    expect(out).to eq('TypeError')
  end
end
