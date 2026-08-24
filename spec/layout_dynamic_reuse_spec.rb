require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/js_engine'

# Layout reuses a subtree across a bare style-state bump (focus, checkedness) when no dynamic
# rule can target it — `subtreeDynFree` / `ancestorsDynFree` in layout.js. That optimization is
# a claim about REACHABILITY: any box a dynamic rule can move, directly, through inheritance, or
# through the flow around it, must still re-lay-out. Every case here reads geometry BEFORE the
# state change, because a cache that is only ever cold cannot serve stale.
RSpec.describe 'layout reuse across dynamic style state' do
  def session_for(css, body)
    html = "<!DOCTYPE html><html><head><style>#{css}</style></head><body>#{body}</body></html>"
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  # `isLaidOutNode` — "is this element rendered at all", the guard every geometry read runs before
  # laying out — is memoised per element on the layout gate's key. Each case below makes the answer
  # flip through a DIFFERENT input of that key, and reads geometry first so a cold cache can't pass.
  it 'stops reporting a rect when an ancestor is hidden between reads' do
    s = session_for('.x { width: 40px; height: 10px }', '<div id="a"><p id="x" class="x">x</p></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const w = () => document.getElementById('x').getBoundingClientRect().width;
        const before = w();
        document.getElementById('a').style.display = 'none';       // an attribute write: settleGen
        const hidden = w();
        document.getElementById('a').style.display = '';
        return [before, hidden, w()];
      })()
    JS
    expect(got).to eq([40, 0, 40])
  end

  it 'stops reporting a rect when a stylesheet arrives that hides an ancestor' do
    s = session_for('.x { width: 40px; height: 10px }', '<div id="a" class="wrap"><p id="x" class="x">x</p></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const w = () => document.getElementById('x').getBoundingClientRect().width;
        const before = w();
        const style = document.createElement('style');
        style.textContent = '.wrap { display: none }';             // a rule change: the layout epoch
        document.head.appendChild(style);
        return [before, w()];
      })()
    JS
    expect(got).to eq([40, 0])
  end

  it 'stops reporting a rect when focus hides an ancestor' do
    css  = '.x { width: 40px; height: 10px } .wrap:focus-within { display: none }'
    body = '<div id="a" class="wrap"><input id="i"><p id="x" class="x">x</p></div>'
    s = session_for(css, body)
    got = s.evaluate_script(<<~JS)
      (() => {
        const w = () => document.getElementById('x').getBoundingClientRect().width;
        const before = w();
        document.getElementById('i').focus();                      // dynamic state
        return [before, w()];
      })()
    JS
    expect(got).to eq([40, 0])
  end

  it 'stops reporting a rect once the element is detached' do
    s = session_for('.x { width: 40px; height: 10px }', '<div id="a"><p id="x" class="x">x</p></div>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const x = document.getElementById('x');
        const before = x.getBoundingClientRect().width;
        x.remove();
        return [before, x.getBoundingClientRect().width];
      })()
    JS
    expect(got).to eq([40, 0])
  end

  it 'resizes the focused element itself' do
    s = session_for(
      '#t { width: 100px } #t:focus { width: 300px }',
      '<input id="t">'
    )
    read = "document.getElementById('t').getBoundingClientRect().width"
    expect(s.evaluate_script(read)).to eq(100)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(300)
  end

  it 'resizes a child that inherits from an ancestor whose rule is dynamic' do
    # The child carries no dynamic candidate of its own — only the ANCESTOR walk can know its
    # `em` basis moved. This is the case `ancestorsDynFree` exists for.
    s = session_for(
      '#wrap { font-size: 10px } #wrap:focus-within { font-size: 32px }',
      '<div id="wrap"><input id="i"><div id="c" style="width: 2em">x</div></div>'
    )
    read = "document.getElementById('c').getBoundingClientRect().width"
    expect(s.evaluate_script(read)).to eq(20)
    s.evaluate_script("document.getElementById('i').focus()")
    expect(s.evaluate_script(read)).to eq(64)
  end

  it 'moves a static sibling below an element the state change grew' do
    # The sibling itself is dyn-free and its subtree is untouched — but the box ABOVE it grew,
    # so its position must move even though its own layout is reused.
    s = session_for(
      '#t { height: 20px } #t:focus { height: 100px } div { margin: 0 }',
      '<input id="t"><div id="below">x</div>'
    )
    read = "document.getElementById('below').getBoundingClientRect().top"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(before + 80)
  end

  it 'reveals a hidden sibling through a dynamic hide rule and reflows below it' do
    s = session_for(
      '#panel { display: none; height: 50px } #t:checked ~ #panel { display: block }',
      '<input type="checkbox" id="t"><div id="panel"></div><div id="below">x</div>'
    )
    read = "document.getElementById('below').getBoundingClientRect().top"
    before = s.evaluate_script(read)
    s.find('#t').click
    expect(s.evaluate_script(read)).to eq(before + 50)
  end

  it 'moves boxes under a :has() whose argument is a dynamic pseudo' do
    # `:has(:checked)` reads checkedness — state no mutation record tracks — so the rule must
    # count as dynamic even though `:has` itself is structural.
    s = session_for(
      '#wrap { padding-top: 0 } #wrap:has(:checked) { padding-top: 40px }',
      '<div id="wrap"><input type="checkbox" id="t"><div id="c">x</div></div>'
    )
    read = "document.getElementById('c').getBoundingClientRect().top"
    before = s.evaluate_script(read)
    s.find('#t').click
    expect(s.evaluate_script(read)).to eq(before + 40)
  end

  it 'honours a dynamic ancestor rule whose ancestor class arrived after the subtree was laid out' do
    # The adversary for any memoised "no dynamic rule reaches this subtree" verdict: the verdict
    # is computed while no `.menu` ancestor exists, then the class ARRIVES (which dirties the
    # ancestor chain downward not at all), and only then does the dynamic state change. A memo
    # keyed without ancestor context serves the pre-`.menu` answer here — the exact hole a
    # review found in a (since-reverted) reuse optimization.
    s = session_for(
      '.menu:hover .item { margin-left: 40px }',
      '<div id="p"><div id="c"><span class="item" id="t">x</span></div></div>'
    )
    read = "document.getElementById('t').getBoundingClientRect().left"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('p').classList.add('menu')")
    expect(s.evaluate_script(read)).to eq(before)
    s.evaluate_script("document._hoverElement = document.getElementById('p')")
    expect(s.evaluate_script(read)).to eq(before + 40)
  end

  it 'keeps a dyn-free subtree correct (and identical) across an unrelated focus change' do
    s = session_for(
      '#t:focus { width: 300px } td { width: 40px; height: 10px }',
      '<input id="t"><table id="tbl"><tr><td>a</td><td>b</td></tr></table>'
    )
    read = "JSON.stringify(document.querySelector('#tbl td').getBoundingClientRect())"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(before)
  end

  # The two REFUSALS a reuse makes (`reuseSubtree`) are what keeps a reused subtree agreeing with a
  # freshly laid-out one. Each case below drives one of them through the mutation that actually
  # reaches them: REMOVING a child marks its parent alone (`recordChildList` — a subtree mark would
  # invalidate the sibling being reused, and there would be nothing to get wrong), so this is the
  # everyday app shape, not a corner. `__csimReuseStats` says WHICH refusal fired, and the control
  # case says the neighbour it does not concern still got its reuse — refusing categorically
  # instead measured 2-7 % slower across Discourse / Redmine / Avo.
  describe 'the reuse refusals' do
    def stats_around(session, script)
      session.evaluate_script(<<~JS)
        (() => {
          const before = globalThis.__csimReuseStats();
          const value = (() => { #{script} })();
          const after = globalThis.__csimReuseStats();
          const diff = {};
          for (const k in after) diff[k] = after[k] - before[k];
          return [value, diff];
        })()
      JS
    end

    it 'measures a stretched flex item again when its line shrinks' do
      # `align-items: stretch` lays an item out twice: once with an auto height to measure it,
      # once at the line's cross size. Once the tall sibling holding the line open is gone, the
      # measure call has to be answered from the item's own content — handing back the stretched
      # height kept the line as tall as it was, and a flexbox that should shrink never shrank
      # (css-flexbox/stretched-child-shrink-on-relayout, css-flexbox/shrinking-column-flexbox).
      css  = '.box { display: flex; align-items: stretch } .big { height: 200px }'
      body = '<div class="box" id="b"><div id="i">item</div><div class="big" id="big"></div></div>'
      read = "document.getElementById('i').getBoundingClientRect().height"
      # …and what it has to come to is what a layout that really ran comes to, which is the whole
      # contract — asked of a second page that never had the tall sibling, so the assertion says
      # "equals a fresh layout" rather than pinning whatever this font measures a line at.
      fresh = session_for(css, '<div class="box"><div id="i">item</div></div>').evaluate_script(read)
      s = session_for(css, body)
      value, diff = stats_around(s, <<~JS)
        const before = #{read};
        document.getElementById('big').remove();
        return [before, #{read}, document.getElementById('b').getBoundingClientRect().height];
      JS
      expect(value).to eq([200, fresh, fresh])
      expect(diff['remeasured']).to be > 0
    end

    it 'lays out a subtree again when it holds an out-of-flow box anchored above it' do
      # The anchor is placed against `.box`, not against the auto-height wrapper it sits in, so
      # the wrapper's subtree cannot simply be moved — `placeAbsolute` runs only inside an
      # ancestor that is really laid out, and a shift would take the anchor along with it.
      css  = '.box { position: relative } .big { height: 200px }'
      body = '<div class="box" id="b"><div id="w"><div id="a" style="position: absolute; bottom: 0; height: 10px">x</div></div><div class="big" id="big"></div></div>'
      s = session_for(css, body)
      value, diff = stats_around(s, <<~JS)
        const a = document.getElementById('a'), b = document.getElementById('b');
        const gap = () => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom;
        const before = [gap(), b.getBoundingClientRect().height];
        document.getElementById('big').remove();
        return before.concat([gap(), b.getBoundingClientRect().height]);
      JS
      # `bottom: 0` means the anchor's bottom edge IS its containing block's, before and after —
      # and the containing block really did shrink, so neither reading is vacuous.
      expect(value).to eq([0, 200, 0, 0])
      expect(diff['escapingAbs']).to be > 0
    end

    it 'still reuses the subtree the change does not reach' do
      # The control: a sibling with no imposed height and no escaping out-of-flow box hands its
      # boxes back whole when a node is removed beside it. ONE hit is the whole assertion —
      # `reuseSubtree` does not recurse, so a `#keep` that was really laid out again would grant
      # its two paragraphs a hit each instead.
      css  = '.big { height: 200px }'
      body = '<div id="keep"><p><span>a</span></p><p><span>b</span></p></div><div class="big" id="big"></div>'
      s = session_for(css, body)
      value, diff = stats_around(s, <<~JS)
        const k = document.getElementById('keep');
        const rect = () => JSON.stringify(k.getBoundingClientRect());
        const before = [rect(), document.body.getBoundingClientRect().height];
        document.getElementById('big').remove();
        return before.concat([rect(), document.body.getBoundingClientRect().height]);
      JS
      expect(value[2]).to eq(value[0])                   # …and its boxes did not move
      expect(value[3]).to eq(value[1] - 200)             # …while the removal really did land
      expect(diff['hit']).to eq(1)
      expect(diff.values_at('escapingAbs', 'remeasured')).to eq([0, 0])
    end
  end
end
