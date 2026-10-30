# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# Fetch "HTTP-redirect fetch" taints a request's origin — its Origin then "null" — where a redirect leaves a URL of
# another origin than the request's own, whatever the request's mode: a no-cors POST led away and on as much as a CORS
# one (fetch_rules.rs `follow_redirect`). The first hop away keeps the origin; so does a chain that stays home.
# (…the other origins served in-process)
RSpec.describe 'a redirected request', :every_host_local do
  include PollUntil

  it 'sends the opaque Origin once a redirect leaves another origin, in no-cors mode too' do
    seen = []
    app  = lambda {|env|
      host, path = env['SERVER_NAME'], env['PATH_INFO']
      seen << [host, env['HTTP_ORIGIN']] if path.start_with?('/hop')
      case path
      when '/hop1' then [307, {'location' => 'http://b.example.com/hop2'}, ['']]
      when '/hop2' then [307, {'location' => 'http://c.example.com/hop3'}, ['']]
      when '/hop3' then [200, {'content-type' => 'text/plain'}, ['ok']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.done = false;
      fetch('/hop1', {method: 'POST', mode: 'no-cors', body: 'x'}).finally(() => { window.done = true; });
    JS
    poll_until { s.evaluate_script('window.done') }
    expect(seen).to eq(
      [
        ['www.example.com', 'http://www.example.com'],
        ['b.example.com', 'http://www.example.com'],
        ['c.example.com', 'null']
      ]
    )
  end

  # …and its Location's bytes that are no UTF-8 percent-encoded, as Chrome sends them (redirect-location-escape).
  it 'follows a Location of bytes no UTF-8 percent-encoded' do
    app = lambda {|env|
      case env['PATH_INFO']
      when '/r' then [302, {'location' => "/x\xFF".b}, ['']]
      when '/x%FF' then [200, {'content-type' => 'text/plain'}, ['landed']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script("window.got = null; fetch('/r').then((r) => r.text().then((t) => { window.got = [new URL(r.url).pathname, t]; }), (e) => { window.got = e.name; });")
    expect(poll_until { s.evaluate_script('window.got') }).to eq(['/x%FF', 'landed'])
  end
end
