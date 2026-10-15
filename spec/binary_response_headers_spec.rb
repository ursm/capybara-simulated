# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A Rack app may hand its header values over binary-tagged — a Net::HTTP-backed proxy's (rack-proxy's) always are —
# and they are the wire's bytes all the same: a Location a navigation and a fetch follow, a Last-Modified, a
# Server-Timing the page reads as text, as the same bytes tagged UTF-8 are.
RSpec.describe 'binary-tagged response headers' do
  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/moved' then [302, {'location' => '/to/日'.b}, ['']]
      when '/timed' then [200, {'content-type' => 'text/plain', 'server-timing' => 'db;dur=53'.b}, ['x']]
      else [200, {'content-type' => 'text/html', 'last-modified' => 'Wed, 21 Oct 2015 07:28:00 GMT'.b}, ['<!DOCTYPE html><body>']]
      end
    })
  }

  it 'follows a Location, and reads a Last-Modified and a Server-Timing' do
    session.visit '/moved'
    session.execute_script(<<~JS)
      Promise.all([fetch('/moved'), fetch('/timed').then(r => r.text())]).then(([moved]) => {
        const timing = performance.getEntriesByName(new URL('/timed', location.href).href)[0].serverTiming[0];
        globalThis.__got = [moved.url, timing.name, timing.duration];
      });
    JS
    poll_until { session.evaluate_script('!!globalThis.__got') }

    expect(session.current_url).to eq('http://www.example.com/to/%E6%97%A5')
    expect(session.evaluate_script('new Date(document.lastModified).getTime()')).to eq(Time.utc(2015, 10, 21, 7, 28).to_i * 1000)
    expect(session.evaluate_script('globalThis.__got')).to eq(['http://www.example.com/to/%E6%97%A5', 'db', 53])
  end
end
