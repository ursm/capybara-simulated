# frozen_string_literal: true

# Shadow A/B of the native (Rust/Servo) selector engine on the PRODUCTION find path —
# `__csimQuery`, the one host fn every Capybara `find` / `all` / `has_css?` goes
# through. It answers the store-migration question the raw-queryIds A/B could not:
# does native matching beat css-select at real app scale ONCE THE COST OF KEEPING THE
# ARENA ALIVE (build + rebuild-on-mutation) is charged against it?
#
# How: with `__csimNativeShadow` on, `__csimQuery` runs BOTH engines — css-select
# stays authoritative (its result is what Capybara gets), native runs beside it,
# timed with a REAL monotonic clock (`__dom.nowNanos`; csim's own clock is virtual and
# frozen during synchronous JS) and PARITY-CHECKED. So this is zero-risk: a native or
# arena bug can only surface as a recorded mismatch, never a wrong find.
#
# The arena rebuilds lazily whenever the DOM changed — a CONSERVATIVE upper bound on
# upkeep (the real migration pays no rebuild). Build time is reported apart from query
# time so both costs are legible. Not a gate (it prints a table); parity IS asserted.
#
# V8 only (needs the native __dom arena + css-select). Run:
#   CSIM_JS_ENGINE=v8 bundle exec rspec spec/native_selector_shadow_spec.rb

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native selector engine SHADOW A/B on the __csimQuery path', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  CARDS = Integer(ENV.fetch('SHADOW_CARDS', '500'))
  ITERS = Integer(ENV.fetch('SHADOW_ITERS', '300'))

  # A representative slice of what an app's finds look like: type + class compounds,
  # descendant / child combinators, attribute operators, structural pseudos, :not.
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

  # Selectors whose truth depends on live element state the arena can't see — native
  # must DEFER these to css-select (recorded as fallbacks, never a wrong subset).
  STATE_SELECTORS = ['input:checked', 'input:required', ':focus', 'p::before'].freeze

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
    form = '<form><input type="checkbox" id="c1"><input type="text" required></form>'
    html = "<!doctype html><html><head><title>Feed</title></head><body><div class=\"feed\">#{form}#{cards}</div></body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  }

  let(:session) { simulated_session(app) }

  # A stats snapshot from the shadow recorder.
  def stats
    session.evaluate_script('globalThis.__csimNativeShadowStats(false)')
  end

  # Run one selector through the production find path (host fn __csimQuery, root 0 =
  # document) ITERS times, entirely in JS — no per-call Ruby/handle marshalling — and
  # return the css / native time it added (µs per iteration) plus the match count.
  def measure(selector, root_expr = '0')
    before = stats
    session.evaluate_script(%(for (let i = 0; i < #{ITERS}; i++) __csimQuery(#{root_expr}, #{selector.to_json});))
    after = stats
    {
      css_us: (after['cssNs'] - before['cssNs']) / 1000.0 / ITERS,
      nat_us: (after['natNs'] - before['natNs']) / 1000.0 / ITERS,
      matched: after['matched'] - before['matched'],
      results: (after['natResults'] - before['natResults']) / [ITERS, 1].max
    }
  end

  it 'matches css-select on every find and reports native-vs-css timings' do
    session.visit '/'
    session.evaluate_script('globalThis.__csimNativeShadow = true')

    # Warm the arena once (the initial build) so per-selector deltas are steady-state
    # QUERY time, not one build amortised into the first selector.
    session.evaluate_script('__csimQuery(0, ".card")')
    warmed = stats
    build_ms = warmed['buildNs'] / 1_000_000.0

    rows = SELECTORS.map {|sel| [sel, measure(sel)] }

    # A within(card) find is the element-scoped path (root = a card handle).
    card_root = 'document.querySelector(".card")._id'
    scoped = measure('.title', card_root)

    # H1 guard: a selector native quietly DECLINED (fallback) or REJECTED (invalid)
    # contributes native_µs = 0 and would flatter the reported speedup while the run
    # stayed green. Every selector here is one native answers today, so it must have
    # been answered on all ITERS — a drop to fallback/invalid means native regressed
    # on a selector it used to handle, and the measurement is no longer trustworthy.
    (rows + [['within(.card) .title', scoped]]).each do |sel, r|
      expect(r[:matched]).to eq(ITERS), "native stopped answering #{sel.inspect} (dropped to fallback/invalid) — speedup would be inflated"
    end

    # State pseudos must DEFER, not guess — prove native declines even though the box
    # really is `:checked` / `:required`.
    session.evaluate_script('document.getElementById("c1").checked = true')
    before_fb = stats['fallbacks']
    STATE_SELECTORS.each {|sel| session.evaluate_script(%(__csimQuery(0, #{sel.to_json}))) }
    fallbacks = stats['fallbacks'] - before_fb

    # A mutation stales the arena; the next find rebuilds it — measure that one rebuild.
    session.evaluate_script('document.querySelectorAll(".card").forEach((c, i) => { if (i % 3 === 0) c.classList.toggle("featured"); })')
    before_rb = stats
    session.evaluate_script('__csimQuery(0, "article.card")')
    after_rb = stats
    rebuild_ms = (after_rb['buildNs'] - before_rb['buildNs']) / 1_000_000.0
    rebuilds   = after_rb['rebuilds'] - before_rb['rebuilds']

    final = stats

    warn format("\n  native selector SHADOW A/B — %d cards, initial arena build %.2f ms, %d iters/selector", CARDS, build_ms, ITERS)
    warn format('  %-34s %6s %10s %10s %8s', 'selector (document-scoped)', 'n', 'css µs', 'native µs', 'speedup')
    rows.each do |sel, r|
      warn format('  %-34s %6d %10.3f %10.3f %7.1fx', sel, r[:results], r[:css_us], r[:nat_us], r[:css_us] / [r[:nat_us], 1e-9].max)
    end
    warn format('  %-34s %6d %10.3f %10.3f %7.1fx', 'within(.card) .title', scoped[:results], scoped[:css_us], scoped[:nat_us], scoped[:css_us] / [scoped[:nat_us], 1e-9].max)

    total_css = rows.sum {|_, r| r[:css_us] }
    total_nat = rows.sum {|_, r| r[:nat_us] }
    warn format('  %-34s %6s %10.3f %10.3f %7.1fx', 'TOTAL (steady-state query)', '', total_css, total_nat, total_css / total_nat)
    warn format("\n  arena upkeep: 1 rebuild after a class mutation = %.2f ms (%d rebuild(s)); state pseudos deferred = %d/%d", rebuild_ms, rebuilds, fallbacks, STATE_SELECTORS.length)
    warn format('  totals over the run — matched finds %d, fallbacks %d, invalid %d, mismatches %d', final['matched'], final['fallbacks'], final['invalid'], final['mismatches'])

    # The load-bearing correctness assertion: native NEVER disagreed with css-select
    # on a find it answered.
    expect(final['mismatches']).to eq(0), "native diverged from css-select: #{final['lastMismatch'].inspect}"
    # No structural selector was silently rejected as invalid (that too would read as
    # native_µs = 0 and skew the totals).
    expect(final['invalid']).to eq(0)
    # And it really did decline the live-state selectors rather than returning a subset.
    expect(fallbacks).to eq(STATE_SELECTORS.length)
  end

  # Guards the two arena-CONSTRUCTION fixes that keep the parity signal honest on real
  # pages: `:empty` must ignore comment / PI children (only text disqualifies), and
  # `:root` must match <html> even though the arena hangs it under a synthetic
  # '#document' node. Both diverge from css-select ONLY if the arena is built wrong —
  # so a mismatch here is exactly the construction bug the shadow path exists to catch.
  it 'keeps :empty (comment children) and :root in parity with css-select' do
    page = <<~HTML
      <!doctype html><html><head><title>t</title></head><body>
        <div id="only-comment"><!-- x --></div>
        <div id="only-ws">   </div>
        <div id="truly-empty"></div>
        <p id="has-text">hi</p>
      </body></html>
    HTML
    with_simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }) do |s|
      s.visit '/'
      s.evaluate_script('globalThis.__csimNativeShadow = true')
      # css-select is authoritative; these must agree with native on the arena's shape.
      ['div:empty', ':empty', ':root', 'html', '*', 'body > div'].each do |sel|
        s.evaluate_script(%(__csimQuery(0, #{sel.to_json})))
      end
      st = s.evaluate_script('globalThis.__csimNativeShadowStats(false)')
      expect(st['mismatches']).to eq(0), "arena diverged from css-select: #{st['lastMismatch'].inspect}"
      # #only-comment and #truly-empty are :empty; #only-ws (whitespace text) and
      # #has-text are not — so `div:empty` really exercised the comment/text split.
      expect(st['matched']).to be > 0
    end
  end
end
