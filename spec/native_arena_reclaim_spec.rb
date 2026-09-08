# frozen_string_literal: true

# Generational arena — per-node slot RECLAMATION. Every element eager-creates an arena node at
# construction (the store flip), so without reclamation a long no-navigation session's transient /
# detached nodes accumulate for the whole page. The generational arena frees a node's slot when its
# JS wrapper is garbage-collected (native-query-shadow.js registers each element with a
# FinalizationRegistry whose callback calls `__dom.dropNode`), and hands the recycled slot a fresh
# GENERATION so any surviving reference — a stale `children` edge left by an unsynced splice, a nid
# still held somewhere — reads absent instead of aliasing the reoccupant. That generation is what
# makes reuse safe (naive index reuse corrupted the tree — proven on Avo before this landed).
#
# The app suites (Avo especially) are the safety oracle for reuse under real churn; they can't show
# that reclamation actually FIRES, so this does: it forces a GC + message-loop pump (what the browser
# does at settle) and checks that a fresh element REUSES a freed slot rather than growing the arena,
# and that the cascade still matches correctly over the churned + reclaimed arena.
#
# V8 only (QuickJS has no `__dom` and no pumpable message loop — reclamation is inert there, still
# correct). Run: CSIM_JS_ENGINE=v8 bundle exec rspec spec/native_arena_reclaim_spec.rb

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native arena reclamation (generational)',
  if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' && !ENV['CSIM_NO_NATIVE_CASCADE'] do
  let(:app) {
    html = <<~HTML
      <!doctype html>
      <html><head><title>reclaim</title>
        <style>.hot { color: rgb(1, 2, 3); }</style>
      </head><body>
        <div id="root"><span class="tag">x</span></div>
      </body></html>
    HTML
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  }

  let(:session) { simulated_session(app) }

  # Force a full GC (with weak processing) then pump the foreground message loop, so the
  # FinalizationRegistry cleanup callbacks run and free the collected nodes' slots — the browser does
  # exactly this at settle; here we drive it directly (twice, GC being best-effort) for determinism.
  def gc_and_pump
    runtime = session.driver.browser.instance_variable_get(:@runtime)
    ctx     = runtime.instance_variable_get(:@ctx)
    2.times do
      ctx.low_memory_notification
      runtime.pump_message_loop
    end
  end

  # The slot index packed into a nid (idx = nid mod 2^INDEX_BITS). Test-only introspection — production
  # JS treats the nid as opaque; here it lets us see whether a fresh node grew the arena or reused a slot.
  IDX_OF = 'const IDX_BITS = 1 << 26;'

  before { session.visit '/' }

  it 'reuses freed slots after the wrappers are collected (growth stays bounded)' do
    # A batch of DETACHED elements: each eager-creates an arena node, none is ever inserted, so once
    # we drop the refs nothing keeps them alive. Record the arena's index high-water via their nids.
    high_water = session.evaluate_script(<<~JS)
      #{IDX_OF}
      globalThis.__probe = [];
      for (let i = 0; i < 300; i++) __probe.push(document.createElement('div'));
      Math.max(...__probe.map(el => el._nid % IDX_BITS));
    JS

    session.evaluate_script('globalThis.__probe = null;')
    gc_and_pump

    # A fresh element must now REUSE one of the freed slots — its index falls at or below the prior
    # high-water. Append-only (no reclamation) would push it strictly higher.
    reused_idx = session.evaluate_script(<<~JS)
      #{IDX_OF}
      document.createElement('div')._nid % IDX_BITS;
    JS

    expect(reused_idx).to be <= high_water
  end

  it 'keeps the cascade correct over a churned + reclaimed arena' do
    # Insert then remove many subtrees under a live element (real syncChildren churn + detached nodes
    # to reclaim), pumping between rounds, then style a SURVIVING element via a class rule. If a reused
    # slot had aliased a stale edge, native cascade matching over the arena would resolve the wrong
    # element; getComputedStyle reads the cascade, so a correct colour proves the arena stayed sound.
    session.evaluate_script(<<~JS)
      const root = document.getElementById('root');
      for (let round = 0; round < 20; round++) {
        const holder = document.createElement('div');
        for (let i = 0; i < 40; i++) {
          const c = document.createElement('p');
          c.className = 'item';
          c.appendChild(document.createTextNode('n' + i));
          holder.appendChild(c);
        }
        root.appendChild(holder);   // linked + synced into the arena
        root.removeChild(holder);   // detached again — its subtree becomes reclaimable
      }
    JS
    gc_and_pump

    color = session.evaluate_script(<<~JS)
      const el = document.querySelector('#root .tag');
      el.classList.add('hot');
      getComputedStyle(el).color;
    JS
    expect(color).to eq('rgb(1, 2, 3)')

    # And the surviving structure still matches natively-answered selectors through css-select's oracle.
    expect(session.all('#root .tag', visible: :all).size).to eq(1)
  end
end
