# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A `<link rel=preload>` fetches by the preload destination its `as` names (HTML "translate a preload destination":
# `fetch`, `font`, `image`, `script`, `style`, `track`, ASCII case-insensitively) — and one whose `as` names none
# (missing, empty, no keyword, `audio`, `worker`) fetches nothing and fires no event, as Chrome and Firefox make no
# request for it, until a change of its `as` names one; nor does one whose `media` does not match, until it does.
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
        <link rel=preload as="audio" href="/audio" onload="seen.push('audio load')" onerror="seen.push('audio error')">
        <link rel=preload as="worker" href="/worker" onload="seen.push('worker load')" onerror="seen.push('worker error')">
        <link id=later rel=preload href="/later" onload="seen.push('later load')" onerror="seen.push('later error')">
        <link id=print rel=preload as="fetch" media="print" href="/print" onload="seen.push('print load')">
        <script>setTimeout(() => { document.getElementById('later').as = 'script'; document.getElementById('print').media = 'all'; }, 100);</script>
      HTML
    }
    s = simulated_session(app)
    s.visit '/'
    got = poll_until { (seen = s.evaluate_script('window.seen')).size == 4 && seen }
    expect([got.sort, requested.sort]).to eq([%w[fetch font later print].map {|n| "#{n} load" }, %w[/fetch /font /later /print]])
  end
end
