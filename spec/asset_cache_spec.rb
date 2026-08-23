# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The process-wide HTTP cache behind `rack_fetch`: what survives a per-test reset. A real
# browser keeps `Cache-Control: immutable` responses across navigations and tests alike (the
# URL is content-addressable, so a kept entry can't shadow a later test's response); anything
# else is dropped at reset so test-local server state reaches the app on the next visit.
RSpec.describe Capybara::Simulated::AssetCache do
  def store(cache, url, cache_control)
    cache.store(url, 200, {'content-type' => 'application/javascript', 'cache-control' => cache_control}, 'body')
  end

  it 'keeps immutable entries across a reset and drops the rest' do
    cache = described_class.new
    store(cache, 'http://app/extra-locales/8143123bbd46f191e83f6e17b6d99ea092ebebc8/en/main.js', 'max-age=31556952, public, immutable')
    store(cache, 'http://app/assets/vendor.js', 'max-age=3600, public')
    cache.clear_volatile
    expect(cache.lookup('http://app/extra-locales/8143123bbd46f191e83f6e17b6d99ea092ebebc8/en/main.js')).not_to be_nil
    expect(cache.lookup('http://app/assets/vendor.js')).to be_nil
  end

  it 'drops everything on a full clear' do
    cache = described_class.new
    store(cache, 'http://app/a.js', 'max-age=31556952, public, immutable')
    cache.clear
    expect(cache.lookup('http://app/a.js')).to be_nil
  end
end

# …and the same contract seen from a session: a `reset!` between visits keeps an immutable
# response out of the Rack app's way and sends a merely max-age'd one back to it. Through
# `fetch()`, not `<script src>` — classic script / stylesheet bodies have their own cross-visit
# cache and would survive either way.
RSpec.describe 'asset cache across reset!' do
  it 'keeps an immutable response and drops a max-age one' do
    hits = Hash.new(0)
    app = lambda {|env|
      path = env['PATH_INFO']
      hits[path] += 1 if env['REQUEST_METHOD'] == 'GET'
      case path
      when '/imm-reset.js'   then [200, {'content-type' => 'application/javascript', 'cache-control' => 'max-age=31536000, public, immutable'}, ['1']]
      when '/plain-reset.js' then [200, {'content-type' => 'application/javascript', 'cache-control' => 'max-age=3600, public'}, ['1']]
      else [200, {'content-type' => 'text/html'}, ['<html><body>ok<script></script></body></html>']]
      end
    }
    s = simulated_session(app)
    fetch_both = lambda {
      s.visit '/'
      s.evaluate_async_script("const done = arguments[0]; Promise.all([fetch('/imm-reset.js').then(r => r.text()), fetch('/plain-reset.js').then(r => r.text())]).then(() => done(true))")
    }
    fetch_both.call
    s.reset!
    fetch_both.call
    expect(hits['/imm-reset.js']).to eq(1)
    expect(hits['/plain-reset.js']).to eq(2)
  end
end
