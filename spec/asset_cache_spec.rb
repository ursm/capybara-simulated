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
  # The cache is process-wide: don't leave the planted immutable entry for later spec files.
  after do
    Capybara::Simulated.clear_http_cache
  end

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

# One fetch per URL per DOCUMENT, as a browser's memory cache gives: the cascade fetches a `<link>`'s sheet and its load
# task asks for it again, a module graph fetches what a `modulepreload` link fetched — and a response with no cache
# headers (every asset of a Rails app in test) crossed Rack twice per page. A `no-store` one is fetched every time, and a
# new document fetches afresh.
RSpec.describe 'one fetch per asset per document' do
  def app(hits, extra_headers = {})
    ->(env) {
      path = env['PATH_INFO']
      hits[path] += 1
      case path
      when '/s.css' then [200, {'content-type' => 'text/css'}.merge(extra_headers), ['p { color: rgb(0, 128, 0) }']]
      when '/m.js'  then [200, {'content-type' => 'text/javascript'}.merge(extra_headers), ['document.title = "m";']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><html><head>
            <link rel="stylesheet" href="/s.css"><link rel="modulepreload" href="/m.js">
            <script type="module" src="/m.js"></script>
          </head><body><p id="p">p</p></body></html>
        HTML
      end
    }
  end

  def visit_twice(hits, headers = {})
    s = simulated_session(app(hits, headers))
    2.times do
      s.visit '/'
      expect(s.evaluate_script("[getComputedStyle(document.getElementById('p')).color, document.title]")).to eq(['rgb(0, 128, 0)', 'm'])
    end
  end

  it 'fetches a stylesheet and a module once per document' do
    hits = Hash.new(0)
    visit_twice(hits)
    expect(hits.values_at('/s.css', '/m.js')).to eq([2, 2])
  end

  # …and a frame's document is a document of its own: navigated again, it fetches its sheet again (Chrome: a reloaded
  # frame's no-cache sheet and script are fetched anew).
  it 'fetches a frame\'s asset again when the frame loads again' do
    hits = Hash.new(0)
    frame_app = ->(env) {
      path = env['PATH_INFO']
      hits[path] += 1
      case path
      when '/f.css' then [200, {'content-type' => 'text/css'}, ["p { width: #{hits[path] * 10}px }"]]
      when '/f'     then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><link rel="stylesheet" href="/f.css"><p id="p">p</p>']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe id="f" src="/f"></iframe>']]
      end
    }
    s = simulated_session(frame_app)
    s.visit '/'
    width = -> { s.within_frame('f') { s.evaluate_script("getComputedStyle(document.getElementById('p')).width") } }
    first = width.call
    s.execute_script("document.getElementById('f').src = '/f?again'")
    expect([first, width.call]).to eq(['10px', '20px'])
  end

  # …and only its OWN memo starts afresh: a frame built while the page loads leaves the page's alone, so a sheet the
  # page links after the frame is still fetched once.
  it 'keeps the page\'s memo while a frame of its own loads' do
    hits = Hash.new(0)
    page_app = ->(env) {
      path = env['PATH_INFO']
      hits[path] += 1
      case path
      when '/s.css', '/t.css' then [200, {'content-type' => 'text/css'}, ['p { color: rgb(0, 128, 0) }']]
      when '/f' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><link rel="stylesheet" href="/s.css">']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><link rel="stylesheet" href="/s.css"><iframe src="/f"></iframe><link rel="stylesheet" href="/t.css"><p id="p">p</p>']]
      end
    }
    s = simulated_session(page_app)
    s.visit '/'
    expect(s.evaluate_script("getComputedStyle(document.getElementById('p')).color")).to eq('rgb(0, 128, 0)')
    expect(hits.values_at('/s.css', '/t.css')).to eq([2, 1])
  end

  it 'fetches a no-store one every time it is asked' do
    hits = Hash.new(0)
    visit_twice(hits, 'cache-control' => 'no-store')
    expect(hits['/s.css']).to be > 2
    expect(hits['/m.js']).to be > 2
  end
end
