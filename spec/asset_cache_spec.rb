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

  # (…a header a Rack 3 app gives as an Array of its fields read as one: `no-store` given as `['no-store']` stored not
  # at all, an ETag revalidated as it was given)
  it 'reads Array fields as one' do
    cache = described_class.new
    cache.store('http://app/n', 200, {'cache-control' => ['no-store'], 'etag' => '"x"'}, 'body')
    expect(cache.lookup('http://app/n')).to be_nil
    cache.store('http://app/e', 200, {'cache-control' => 'no-cache', 'etag' => ['"v1"'], 'content-length' => '4'}, 'body')
    entry = cache.lookup('http://app/e')
    expect(cache.revalidation_headers(entry)).to eq('If-None-Match' => '"v1"')
  end

  # (…and a 304 updating the stored fields with the ones it carries — a rotated ETag what the next revalidation sends —
  # but for those describing a content it carries none of, and the driver's own: RFC 9111 §3.2, §4.3.4)
  it 'updates what is stored from a 304' do
    cache = described_class.new
    cache.store('http://app/e', 200, {'cache-control' => 'no-cache', 'etag' => '"v1"', 'content-length' => '4', 'set-cookie' => 'a=1'}, 'body')
    entry = cache.lookup('http://app/e')
    before = entry.headers
    cache.refresh('http://app/e', entry, {'etag' => '"v2"', 'content-length' => '0', 'x-csim-status-text' => 'Not Modified', 'set-cookie' => 'b=2'})
    expect(cache.revalidation_headers(entry)).to eq('If-None-Match' => '"v2"')
    expect(entry.headers.to_h.slice('content-length', 'x-csim-status-text', 'set-cookie')).to eq('content-length' => '4')
    expect([entry.no_cache, before['etag']]).to eq([true, '"v1"'])
    # (…a new Date shortening an Expires; and a 304 that forbids storing it dropping the entry)
    now = Time.now
    cache.store('http://app/x', 200, {'date' => (now - 50).httpdate, 'expires' => (now + 10).httpdate}, 'body')
    expiring = cache.lookup('http://app/x')
    cache.refresh('http://app/x', expiring, {'date' => now.httpdate})
    expect(expiring.fresh?(now + 30)).to be(false)
    cache.refresh('http://app/e', entry, {'cache-control' => 'no-store'})
    expect(cache.lookup('http://app/e')).to be_nil
  end

  # (…its freshness RFC 9111's: the age it came with taken off its lifetime, the first of two max-ages read, an invalid
  # Expires — "0" the common one — already in the past)
  it 'counts the age a response came with, the first max-age, and an invalid Expires as stale' do
    cache = described_class.new
    now   = Time.now
    cache.store('http://app/aged', 200, {'cache-control' => 'max-age=60', 'age' => '50'}, 'body')
    cache.store('http://app/twice', 200, {'cache-control' => 'max-age=60, max-age=1'}, 'body')
    cache.store('http://app/expired', 200, {'expires' => '0', 'etag' => '"e"'}, 'body')
    expect(cache.lookup('http://app/aged').fresh?(now + 20)).to be(false)
    expect(cache.lookup('http://app/aged').fresh?(now + 5)).to be(true)
    expect(cache.lookup('http://app/twice').fresh?(now + 30)).to be(true)
    expect(cache.lookup('http://app/expired').fresh?(now)).to be(false)
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
# headers (every asset of a Rails app in test) crossed Rack twice per page, a failed one three times. A `no-store` one is
# fetched every time, and a new document fetches afresh.
RSpec.describe 'one fetch per asset per document' do
  def app(hits, extra_headers = {})
    ->(env) {
      path = env['PATH_INFO']
      hits[path] += 1
      case path
      when '/s.css' then [200, {'content-type' => 'text/css'}.merge(extra_headers), ['p { color: rgb(0, 128, 0) }']]
      when '/m.js'  then [200, {'content-type' => 'text/javascript'}.merge(extra_headers), ['document.title = "m";']]
      when '/404.css' then [404, {'content-type' => 'text/css'}, ['']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><html><head>
            <link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="/404.css"><link rel="modulepreload" href="/m.js">
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

  # (…a sheet that failed to load as well: the cascade, its `.sheet` and its `error` event asked for it again)
  it 'fetches a stylesheet and a module once per document' do
    hits = Hash.new(0)
    visit_twice(hits)
    expect(hits.values_at('/s.css', '/404.css', '/m.js')).to eq([2, 2, 2])
  end

  # …and a preload of a sheet or a classic script is the fetch its consumer of the same mode takes (HTML's map of
  # preloaded resources) — one of another mode none it matches.
  it 'takes a preloaded sheet and script' do
    hits = Hash.new(0)
    preload_app = ->(env) {
      hits[env['PATH_INFO']] += 1
      case env['PATH_INFO']
      when '/p.css' then [200, {'content-type' => 'text/css'}, ['p { color: rgb(0, 128, 0) }']]
      when '/p.js', '/q.js' then [200, {'content-type' => 'text/javascript'}, ['window.ran = (window.ran || 0) + 1']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html>
          <link rel="preload" as="style" href="/p.css"><link rel="preload" as="script" href="/p.js">
          <link rel="preload" as="script" href="/q.js" crossorigin>
          <link rel="stylesheet" href="/p.css"><script src="/p.js"></script><script src="/q.js"></script><p id="p">p</p>
        HTML
      end
    }
    s = simulated_session(preload_app)
    s.visit '/'
    expect(s.evaluate_script("[getComputedStyle(document.getElementById('p')).color, window.ran]")).to eq(['rgb(0, 128, 0)', 2])
    expect(hits.values_at('/p.css', '/p.js', '/q.js')).to eq([1, 1, 2])
  end

  # …and a failed fetch the element's alone: a link inserted again after its sheet failed fetches it again (Chrome:
  # its memory cache keeps no error), and a preload of another destination is none a sheet takes (HTML's map of
  # preloaded resources keys by it).
  it 'fetches again what failed, and what was preloaded as another destination' do
    hits = Hash.new(0)
    retry_app = ->(env) {
      path = env['PATH_INFO']
      hits[path] += 1
      case path
      when '/flip.css' then hits[path].odd? ? [404, {'content-type' => 'text/css'}, ['']] : [200, {'content-type' => 'text/css'}, ['p { color: rgb(0, 128, 0) }']]
      when '/s.css' then [200, {'content-type' => 'text/css'}, ['p { width: 10px }']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><link rel="preload" as="script" href="/s.css"><link rel="stylesheet" href="/flip.css" id="l"><p id="p">p</p>']]
      end
    }
    s = simulated_session(retry_app)
    s.visit '/'
    s.execute_script(<<~JS)
      window.events = [];
      const l = Object.assign(document.createElement('link'), {rel: 'stylesheet', href: '/flip.css', onload: () => events.push('load'), onerror: () => events.push('error')});
      document.head.append(l, Object.assign(document.createElement('link'), {rel: 'stylesheet', href: '/s.css'}));
    JS
    expect(s.evaluate_script("[events, getComputedStyle(document.getElementById('p')).color]")).to eq([['load'], 'rgb(0, 128, 0)'])
    expect(hits.values_at('/flip.css', '/s.css')).to eq([2, 2])
    # (…the same link too, once it obtains another sheet: connected again)
    s.execute_script(<<~JS)
      window.again = Object.assign(document.createElement('link'), {rel: 'stylesheet', href: '/flip.css?again', onload: () => events.push('again')});
      document.head.append(again);
    JS
    s.execute_script('again.remove(); document.head.append(again)')
    expect(s.evaluate_script('events')).to eq(%w[load again])
    expect(hits['/flip.css']).to eq(4)
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
