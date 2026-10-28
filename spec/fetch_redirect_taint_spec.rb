# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Fetch "HTTP-redirect fetch" taints a request's origin — its Origin then "null" — where a redirect leaves a URL of
# another origin than the request's own, whatever the request's mode: a no-cors POST led away and on as much as a CORS
# one (fetch_rules.rs `follow_redirect`). The first hop away keeps the origin; so does a chain that stays home.
RSpec.describe 'a redirected request' do
  include PollUntil

  around do |example|
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origins served in-process
    example.run
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end

  it "sends the opaque Origin once a redirect leaves another origin, in no-cors mode too" do
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
end
