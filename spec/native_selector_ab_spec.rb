# frozen_string_literal: true

# A/B for the native (Rust/Servo) selector engine vs the JS css-select engine, on a
# realistic app-scale page. Proves two things the DOM-in-Rust store migration rests on:
#   1. CORRECTNESS — native queryIds returns the same element set as css-select.
#   2. SPEED — native matching over the live arena is faster (the whole point: no
#      per-navigation mirror-serialization tax, which is why the earlier mirror lost).
#
# Timing is measured as WALL time from Ruby around evaluate_script loops — csim's clock
# is virtual and frozen during synchronous JS, so in-JS Date.now() can't time this.
#
# Not a pass/fail perf gate (it prints a table); the correctness parity IS asserted.

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native selector engine A/B vs css-select' do
  CARDS = Integer(ENV.fetch('AB_CARDS', '500'))
  ITERS = Integer(ENV.fetch('AB_ITERS', '300'))

  SELECTORS = [
    '.card',
    'article.card',
    '.card .title',
    '.card-body > a.more',
    'a[href^="/x/"]',
    'button.btn.primary',
    '.card:nth-child(2n)',
    '[data-index="250"]',
    '.feed > .card .badge.new',
    '.card-footer .count',
    'article:not(.featured) .title',
    '.card h2.title'
  ].freeze

  let(:app) {
    cards = (1..CARDS).map {|i|
      <<~CARD
        <article class="card#{' featured' if (i % 10).zero?}" id="card-#{i}" data-index="#{i}">
          <header class="card-header"><h2 class="title">Card #{i}</h2><span class="badge new">new</span></header>
          <div class="card-body"><p class="excerpt">Excerpt #{i}.</p><a class="more" href="/x/#{i}">more</a></div>
          <footer class="card-footer"><button class="btn primary" type="button">Like</button><span class="count">#{i % 7}</span></footer>
        </article>
      CARD
    }.join
    html = "<!doctype html><html><head><title>Feed</title></head><body><div class=\"feed\">#{cards}</div></body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  }

  let(:session) { simulated_session(app) }

  # Walk the parsed document and build the native arena; also stamp each element with
  # its nativeId so css-select results map back for comparison. Returns the build time.
  BUILD_JS = <<~JS
    (function () {
      __dom.resetArena();
      // Every node, text and comments included (`:empty` reads them), and <html> under a document node (`:root`).
      function walk(el, parentNid) {
        const attrs = [];
        for (const n of el.getAttributeNames()) attrs.push(n, el.getAttribute(n));
        const ns = el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? '' : (el.namespaceURI || '');
        const nid = __dom.importNode(el.localName, ns, parentNid, attrs);
        el.__nid = nid;
        for (const c of el.childNodes) {
          if (c.nodeType === 1) walk(c, nid);
          else __dom.createNode(c.nodeType, c.data == null ? '' : c.data, nid);
        }
        return nid;
      }
      globalThis.__abRoot = walk(document.documentElement, __dom.createNode(9, '', -1));
      return true;
    })();
  JS

  it 'matches css-select exactly and reports timings' do
    session.visit '/'
    session.evaluate_script(BUILD_JS)

    wall = ->(&blk) { t = Process.clock_gettime(Process::CLOCK_MONOTONIC); blk.call; (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t) * 1000.0 }

    rows = SELECTORS.map {|sel|
      esc = sel.gsub('\\', '\\\\\\\\').gsub('"', '\\"')

      # correctness: compare the two result sets by nativeId
      parity = session.evaluate_script(<<~JS)
        (function () {
          const cssIds = Array.from(document.querySelectorAll("#{esc}")).map(e => e.__nid).sort((a,b)=>a-b);
          const natIds = (__dom.queryIds(globalThis.__abRoot, "#{esc}") || []).sort((a,b)=>a-b);
          return JSON.stringify(cssIds) === JSON.stringify(natIds) ? cssIds.length : ("MISMATCH css=" + cssIds.length + " nat=" + natIds.length);
        })();
      JS
      expect(parity).to be_a(Integer), "selector #{sel.inspect}: #{parity}"

      css_ms = wall.call { session.evaluate_script(%(for (let i=0;i<#{ITERS};i++) document.querySelectorAll("#{esc}");)) }
      nat_ms = wall.call { session.evaluate_script(%(for (let i=0;i<#{ITERS};i++) __dom.queryIds(globalThis.__abRoot, "#{esc}");)) }

      { sel: sel, n: parity, css_us: css_ms * 1000.0 / ITERS, nat_us: nat_ms * 1000.0 / ITERS }
    }

    build_ms = wall.call { session.evaluate_script(BUILD_JS) }

    warn format("\n  native selector A/B — %d cards, arena build %.1f ms, %d iters/selector\n", CARDS, build_ms, ITERS)
    warn format('  %-34s %6s %10s %10s %8s', 'selector', 'n', 'css µs', 'native µs', 'speedup')
    rows.each do |r|
      warn format('  %-34s %6d %10.2f %10.2f %7.1fx', r[:sel], r[:n], r[:css_us], r[:nat_us], r[:css_us] / r[:nat_us])
    end
    total_css = rows.sum {|r| r[:css_us] }
    total_nat = rows.sum {|r| r[:nat_us] }
    warn format('  %-34s %6s %10.2f %10.2f %7.1fx', 'TOTAL', '', total_css, total_nat, total_css / total_nat)
  end
end
