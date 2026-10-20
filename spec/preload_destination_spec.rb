# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A `<link rel=preload>` fetches by the potential destination its `as` names (HTML "fetch and process the linked
# resource", preload; ASCII case-insensitively, `fetch` the empty destination) — and one whose `as` names none (missing,
# empty, no keyword) fetches nothing and fires no event: Chrome and Firefox make no request for it.
RSpec.describe 'a preload’s destination' do
  it 'fetches by its `as`, and nothing for one naming no destination' do
    requested = []
    app = lambda {|env|
      requested << env['PATH_INFO'] unless env['PATH_INFO'] == '/'
      next [200, {'content-type' => 'text/plain'}, ['x']] unless env['PATH_INFO'] == '/'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8"><script>window.seen = [];</script>
        <link rel=preload href="/none" onload="seen.push('none load')" onerror="seen.push('none error')">
        <link rel=preload as="" href="/empty" onload="seen.push('empty load')" onerror="seen.push('empty error')">
        <link rel=preload as="bogus" href="/bogus" onload="seen.push('bogus load')" onerror="seen.push('bogus error')">
        <link rel=preload as="FETCH" href="/fetch" onload="seen.push('fetch load')" onerror="seen.push('fetch error')">
        <link rel=preload as="font" href="/font" onload="seen.push('font load')" onerror="seen.push('font error')">
      HTML
    }
    s = simulated_session(app)
    s.visit '/'
    got = poll_until { (seen = s.evaluate_script('window.seen')).size == 2 && seen }
    expect([got.sort, requested.sort]).to eq([['fetch load', 'font load'], ['/fetch', '/font']])
  end
end
