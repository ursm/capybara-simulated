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
  # …and one memo whose answer is a question about TEXT, not about structure. CSS Grid §4 makes a grid's
  # contiguous run of bare text an anonymous ITEM — but only when the run is not all white space — so an edit
  # that turns `'   '` into `'xx'` creates a box and an edit the other way destroys one. A `characterData`
  # mutation is NOT structural (`markLayoutDirty` with no `structural`), so a memo keyed on `_lbStruct` would
  # survive it: measured that way, the sibling stayed in column 0 where Chrome moves it to 19.20. Keyed on the
  # PASS stamp it does not, because `markLayoutDirty` walks up the flat tree marking `_lbDirty`.
  # BOTH directions: the creating edit alone would pass on a memo that simply never caches.
  it 'creates and destroys an anonymous grid item when only the text changes' do
    s = session_for('body{margin:0}', '<div id="g" style="width:200px;display:grid;grid-template-columns:min-content min-content;' \
                        'font:16px monospace">   <div id="b" style="width:9px;height:4px"></div></div>')
    x = -> { s.evaluate_script("document.getElementById('b').getBoundingClientRect().x") }
    expect(x.call).to eq(0)                     # …all white space: §4 renders it, and makes no item
    s.evaluate_script("document.getElementById('g').firstChild.data = 'xx'")
    expect(x.call).to be_within(0.05).of(19.2)  # …an item now, so the sibling is in column 1 (Chrome 19.203125)
    s.evaluate_script("document.getElementById('g').firstChild.data = '   '")
    expect(x.call).to eq(0)
  end

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
    # …plus the UA border and padding a text `<input>` puts outside its `content-box` width.
    expect(s.evaluate_script(read)).to eq(108)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(308)
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

  # The two REFUSALS a reuse makes (`reuseSubtree`), and the one thing it CARRIES, are what keeps a reused
  # subtree agreeing with a freshly laid-out one. Each case below drives one of them through the mutation that actually
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

    it 'carries a float the context above records through a reuse' do
      # A float's RECTANGLE is pushed into the formatting context of an ancestor (`placeFloat` →
      # `fc.items`), and a reuse returns before `layoutElementInner` ever runs — so a reused subtree
      # pushed nothing, the context came out with no float in it, and every `clear` and every band
      # below it lost the exclusion. It survived because the mutation has to dirty a SIBLING: the
      # float's own subtree lays out again and is right, and one fresh layout per page is all any of
      # this campaign's instruments ever did (`sweep2.rb`'s `CSIM_SWEEP_INCREMENTAL` exists for this).
      #
      # REFUSING the reuse is the obvious fix and is far too expensive — 300 `.row > .col { float: left }`
      # rows went 2.15 ms → 66.4 ms per relayout, because every row carries a float. The rectangle is
      # instead REMEMBERED, relative to the box holding it, and pushed again where the reuse puts it.
      page = ->(float) {
        '<div id="b" style="width:300px"><div id="pad" style="height:10px"></div>' \
        "<div>#{float}</div>" \
        '<div id="clr" style="clear:left;height:5px"></div></div>'
      }
      read = "document.getElementById('clr').getBoundingClientRect().y"
      # What the answer has to be is what a layout that really ran comes to — and, so the reading is not
      # vacuous, the SAME page without the float puts the cleared box 50 higher.
      floated = session_for('', page.call('<div style="float:left;width:50px;height:50px"></div>')).evaluate_script(read)
      bare    = session_for('', page.call('')).evaluate_script(read)
      expect(floated - bare).to eq(50)

      s = session_for('', page.call('<div style="float:left;width:50px;height:50px"></div>'))
      value, diff = stats_around(s, <<~JS)
        const before = #{read};
        document.getElementById('pad').setAttribute('data-x', '1');
        return [before, #{read}];
      JS
      expect(value).to eq([floated, floated])
      expect(diff['floatsRepushed']).to be > 0
      expect(diff['hit']).to be > 0                # …and it really was a REUSE, not a re-layout

      # …for as many GENERATIONS as the page lives. The ancestors above a reuse root were laid out fresh,
      # which cleared their own lists, so the reuse has to record the rectangle on them again — without
      # that the memory survives exactly one mutation and the next one, sited anywhere else, loses the
      # float permanently. TWO differently-sited mutations is the shortest sequence that reaches it.
      deep = ->(pad) {
        %(<div id="b" style="width:300px"><div id="pad" style="height:#{pad}px"></div>) +
        '<div id="mid"><div><div style="float:left;width:50px;height:50px"></div></div></div>' \
        '<div id="clr" style="clear:left;height:5px"></div></div>'
      }
      read = "document.getElementById('clr').getBoundingClientRect().y"
      # …compared against sessions that really laid out at each pad height, not against a delta: two
      # readings can move by the right amount and both be wrong.
      at10 = session_for('', deep.call(10)).evaluate_script(read)
      at30 = session_for('', deep.call(30)).evaluate_script(read)
      expect(at30 - at10).to eq(20)

      d = session_for('', deep.call(10))
      expect(d.evaluate_script(<<~JS)).to eq([at10, at10, at30])
        (() => {
          const y = () => #{read};
          const before = y();
          document.getElementById('mid').setAttribute('data-x', '1');   // generation 1
          const gen1 = y();
          document.getElementById('pad').style.height = '30px';         // generation 2, a different site
          return [before, gen1, y()];
        })()
      JS
    end

    it 'keeps a vertical-aligned cell\'s content where it is across relayouts' do
      # `layoutTable` aligns a cell's content by SHIFTING the whole subtree down and putting the box back.
      # A cell laid out fresh starts with its content at the box, but a REUSED cell hands back content
      # still carrying the previous pass's shift — and adding the whole shift again walked it down the
      # page by one slack per relayout, unbounded, while the table stayed the same height. So the shift is
      # applied as a delta from what the content already carries. Six passes, dirtying the TABLE so that
      # the cells (not the table) are what is reused; Chrome: 17 every time.
      body = '<table id="t" style="width:300px"><tr>' \
             '<td style="vertical-align:baseline;font-size:32px">BIG</td>' \
             '<td style="vertical-align:baseline"><input id="i"></td></tr></table>'
      s = session_for('', body)
      fresh = session_for('', body).evaluate_script("document.getElementById('i').getBoundingClientRect().y")
      ys = s.evaluate_script(<<~JS)
        (() => {
          const y = () => document.getElementById('i').getBoundingClientRect().y;
          const out = [y()];
          for (let k = 1; k < 6; k++) { document.getElementById('t').setAttribute('data-x', String(k)); out.push(y()); }
          return out;
        })()
      JS
      expect(ys).to eq([fresh] * 6)
      # …and a BLOCK-level child, whose baseline is read off its box rather than off a line. A line's
      # baseline is stamped relative to the cell and immune to the carried shift; a block child's `_lb.y`
      # carries it, and reading that as the baseline told the row the cell was already aligned — so the
      # shift was taken back, and a `display: block` `<select>` went 18, 3, 18, 3 (Chrome: 18).
      bsel = body.sub('<input id="i">', '<select id="i" style="display:block"><option>a</option></select>')
      s3 = session_for('', bsel)
      f3 = session_for('', bsel).evaluate_script("document.getElementById('i').getBoundingClientRect().y")
      ys3 = s3.evaluate_script(<<~JS)
        (() => {
          const y = () => document.getElementById('i').getBoundingClientRect().y;
          const out = [y()];
          for (let k = 1; k < 4; k++) { document.getElementById('t').setAttribute('data-x', String(k)); out.push(y()); }
          return out;
        })()
      JS
      expect(ys3).to eq([f3] * 4)
      # …and the same for `middle` and `bottom`, whose slack is the row less the content rather than a baseline
      %w[middle bottom].each do |va|
        b2 = %(<table id="t" style="width:300px"><tr><td style="height:80px"></td><td style="vertical-align:#{va}"><input id="i"></td></tr></table>)
        s2 = session_for('', b2)
        f2 = session_for('', b2).evaluate_script("document.getElementById('i').getBoundingClientRect().y")
        ys2 = s2.evaluate_script(<<~JS)
          (() => {
            const y = () => document.getElementById('i').getBoundingClientRect().y;
            const out = [y()];
            for (let k = 1; k < 4; k++) { document.getElementById('t').setAttribute('data-x', String(k)); out.push(y()); }
            return out;
          })()
        JS
        expect(ys2).to eq([f2] * 4), va
      end
    end

    it 'lets a row shrink back while its other cell is reused' do
      # `layoutTable` stretches a cell's box to the ROW, on the same object a reuse hands back — so a reused
      # auto-height cell answered with the row it was last stretched to, and the row could never SHRINK while
      # any cell in it was reused. An indefinite question asked of a reused cell is answered from its
      # CONTENT (`_lbCellContentH`, floored by a declared minimum), as a fresh layout answers it.
      # Chrome, table height over the sequence 80px → 20px → 0 → 80px on the sibling: 80, 20, [one line], 80.
      body = '<table id="t" style="width:300px;border-spacing:0"><tr>' \
             '<td id="a" style="padding:0">cell</td><td id="b" style="padding:0;height:80px"></td></tr></table>'
      line = session_for('', '<table style="width:300px;border-spacing:0"><tr><td id="a" style="padding:0">cell</td></tr></table>')
               .evaluate_script("document.getElementById('a').getBoundingClientRect().height")
      s = session_for('', body)
      value, diff = stats_around(s, <<~JS)
        const h = () => [document.getElementById('t').getBoundingClientRect().height,
                         document.getElementById('a').getBoundingClientRect().height];
        const out = [h()];
        for (const v of ['20px', '0', '80px']) { document.getElementById('b').style.height = v; out.push(h()); }
        return out;
      JS
      expect(value).to eq([[80, 80], [20, 20], [line, line], [80, 80]])
      expect(diff['hit']).to be > 0                 # …and cell `a` really was reused, not laid out again

      # …and the cell's scroll EXTENT follows the shorter box: `layoutTable` re-stamps only a cell the row grew
      # or re-aligned, so a `vertical-align: top` cell (no re-align) kept a row-tall `scrollHeight` — 80 where
      # its box, and Chrome, said 18. Read through an `overflow: auto` wrapper, which is what a page scrolls.
      topped = %(<div id="w" style="height:10px;overflow:auto">#{body.sub('<td id="a" style="padding:0">', '<td id="a" style="padding:0;vertical-align:top">')}</div>)
      w = session_for('', topped)
      sh = w.evaluate_script(<<~JS)
        (() => { const r = () => [document.getElementById('w').scrollHeight, document.getElementById('a').scrollHeight];
          const before = r(); document.getElementById('b').style.height = '0'; return [before, r()]; })()
      JS
      expect(sh).to eq([[80, 80], [line, line]])

      # …and the content height a cell measured is a CELL's answer: an element that was a cell and is a
      # block now (the table around it lost its display) must not answer a later reuse with it. Chrome: the
      # block is its 50px child tall, before and after the sibling changes again.
      ex = session_for('', '<div id="t" style="display:table;width:300px"><div id="r" style="display:table-row">' \
                           '<div id="a" style="display:table-cell">x</div><div id="b" style="display:table-cell;height:80px"></div></div></div>' \
                           '<div id="after">after</div>')
      steps = ex.evaluate_script(<<~JS)
        (() => {
          const r = () => [document.getElementById('a').getBoundingClientRect().height,
                           document.getElementById('after').getBoundingClientRect().y - document.getElementById('t').getBoundingClientRect().y];
          const out = [];
          document.getElementById('b').style.height = '20px'; out.push(r());          // reused AS A CELL
          for (const id of ['t', 'r', 'a', 'b']) document.getElementById(id).style.display = 'block';
          document.getElementById('a').innerHTML = '<div style="height:50px"></div>';  // fresh, as a block
          document.getElementById('b').style.height = '30px'; out.push(r());
          document.getElementById('b').style.height = '40px'; out.push(r());          // reused AS A BLOCK
          return out;
        })()
      JS
      expect(steps).to eq([[20, 20], [50, 80], [50, 90]])

      # …a declared cell height is a MINIMUM. (This subcase reaches a FRESH layout rather than a reuse — a
      # declared height asks a definite question, which the row's stretch then refuses — so it pins the
      # floor's answer, not the reuse path.)
      floored = body.sub('<td id="a" style="padding:0">', '<td id="a" style="padding:0;height:40px">')
      f = session_for('', floored)
      hs = f.evaluate_script(<<~JS)
        (() => { const h = () => document.getElementById('t').getBoundingClientRect().height;
          const out = [h()]; for (const v of ['20px', '80px']) { document.getElementById('b').style.height = v; out.push(h()); } return out; })()
      JS
      expect(hs).to eq([80, 40, 80])

      # …and a cell's own min/max-height, where they apply, clamp the reused answer as they clamp a fresh one: a
      # VERTICAL cell's height is its inline axis, and its `min-height: 80px` held its row at 80 — on a fresh page
      # and in Chrome — but a reuse answered its 24px content and the row fell to the sibling's 20.
      vertical = body.sub('height:80px', 'height:20px')
                     .sub('<td id="a" style="padding:0">', '<td id="a" style="padding:0;writing-mode:vertical-lr;min-height:80px">')
      v = session_for('body{font:16px monospace}', vertical)
      value, diff = stats_around(v, <<~JS)
        const h = () => document.getElementById('t').getBoundingClientRect().height;
        const out = [h()];
        for (const px of ['30px', '20px']) { document.getElementById('b').style.height = px; out.push(h()); }
        return out;
      JS
      expect(value).to eq([80, 80, 80])
      expect(diff['hit']).to be > 0

      # …and a box ANCHORED to a cell by its insets is placed against the ROW-tall box, which only the flush
      # inside a real layout of the cell does — so such a cell is laid out again rather than reused, or the
      # overlay stays at the bottom of the row the cell used to fill. Chrome: `bottom: 0` at 30, then 90
      # once the sibling grows the row from 40 to 100.
      anchored = '<table id="t" style="width:300px;border-spacing:0"><tr>' \
                 '<td style="padding:0;position:relative"><div id="ov" style="position:absolute;bottom:0;height:10px;width:10px"></div>x</td>' \
                 '<td id="grow" style="padding:0;height:40px"></td></tr></table>'
      a = session_for('', anchored)
      value, diff = stats_around(a, <<~JS)
        const y = () => document.getElementById('ov').getBoundingClientRect().y - document.getElementById('t').getBoundingClientRect().y;
        const before = y();
        document.getElementById('grow').style.height = '100px';
        return [before, y()];
      JS
      expect(value).to eq([30, 90])
      expect(diff['rowAnchored']).to be > 0
    end

    it 'lays out a subtree again when the floats around it changed' do
      # The other half of the float carry: a subtree's lines were laid out AGAINST the floats already in the
      # context around it, and a reuse that did not ask handed the subtree back beside floats that were no
      # longer there. The floats a box can meet are stamped, relative to it, when it is laid out, and a reuse
      # whose set differs is refused. Chrome, `#f2`'s x: 50 beside the first float; 0 once the first float's
      # wrapper contains it (`overflow: hidden`); 50 again; 120 once the first float grows to 120px.
      body = '<div style="height:10px"></div>' \
             '<div id="A"><div id="f1" style="float:left;width:50px;height:50px"></div></div>' \
             '<div><div id="f2" style="float:left;width:30px;height:90px"></div></div>' \
             '<div id="clr" style="clear:left;height:5px"></div>'
      s = session_for('', body)
      value, diff = stats_around(s, <<~JS)
        // …relative to the body's edge: this helper's page keeps the UA body margin
        const x = () => document.getElementById('f2').getBoundingClientRect().x - document.body.getBoundingClientRect().x;
        const out = [x()];
        document.getElementById('A').style.overflow = 'hidden'; out.push(x());
        document.getElementById('A').style.overflow = '';       out.push(x());
        document.getElementById('f1').style.width = '120px';    out.push(x());
        return out;
      JS
      expect(value).to eq([50, 0, 50, 120])
      expect(diff['floatBand']).to be > 0
      # …and a subtree the floats did NOT change around is still reused, free of charge
      expect(diff['hit']).to be > 0

      # …the set reaches DOWN to the holder's own floats. A holder that starts no context does not grow to
      # contain its float, and that float was placed (`floatFitY`) against outer floats entirely below the
      # holder's box — so a change there is invisible to the box's own span. `#f2` drops under `#f1`; `#g`
      # (too wide to sit beside `#f1`) drops under `#f2`; then `#f2` grows 50 → 80. Chrome: `#g` 100 → 130,
      # the cleared box 110 → 140.
      drop = '<div style="width:200px"><div style="float:left;width:50px;height:50px"></div>' \
             '<div id="P"><div id="f2" style="float:left;width:160px;height:50px"></div></div>' \
             '<div id="B"><div style="height:18px"></div><div id="g" style="float:left;width:160px;height:10px"></div></div>' \
             '<div id="clr" style="clear:left;height:5px"></div></div>'
      d = session_for('', drop)
      value, diff = stats_around(d, <<~JS)
        const y = id => document.getElementById(id).getBoundingClientRect().y - document.body.getBoundingClientRect().y;
        const before = [y('g'), y('clr')];
        document.getElementById('f2').style.height = '80px';
        return before.concat([y('g'), y('clr')]);
      JS
      expect(value).to eq([100, 110, 130, 140])
      expect(diff['floatBand']).to be > 0

      # …and DOWN to the box's overflowing content. A holder whose declared height does not contain its
      # lines lays them out against floats past its box just the same: a 10px holder of a long paragraph,
      # pulled up beside a float that starts below the holder's box, kept the paragraph 80 tall when the
      # float widened — Chrome and a fresh layout say 160.
      over = '<div style="width:400px;font:16px/20px monospace"><div style="height:30px"></div>' \
             '<div id="f" style="float:left;width:100px;height:100px"></div>' \
             '<div style="height:10px;margin-top:-30px"><p id="p" style="margin:0">' + ('word ' * 40) + '</p></div>' \
             '<div id="tail" style="clear:both;height:5px"></div></div>'
      o = session_for('', over)
      fresh = session_for('', over.sub('width:100px;height:100px', 'width:300px;height:100px'))
                .evaluate_script("document.getElementById('p').getBoundingClientRect().height")
      value, diff = stats_around(o, <<~JS)
        const h = () => document.getElementById('p').getBoundingClientRect().height;
        const before = h();
        document.getElementById('f').style.width = '300px';
        return [before, h()];
      JS
      expect(value[1]).to eq(fresh)
      expect(value[1]).to be > value[0]
      expect(diff['floatBand']).to be > 0

      # …while a box with a context of ITS OWN beside a float is reused, not refused: it reads no outer
      # float (its x and width the parent recomputes), and comparing it against the floats beside it
      # refused an `overflow: hidden` main column next to a sidebar on every pass.
      # (The float and the column are BODY-level siblings of the header: wrapped together they would be one
      # reuse root and the column never asked on its own.)
      cols = '<div id="hdr">h</div><div style="float:left;width:100px;height:300px"></div>' \
             '<div id="main" style="overflow:hidden">' + ('<p>t</p>' * 20) + '</div>'
      c = session_for('', cols)
      value, diff = stats_around(c, <<~JS)
        const x = () => document.getElementById('main').getBoundingClientRect().x;   // …laid out once BEFORE the mutation
        const before = x();
        document.getElementById('hdr').setAttribute('data-x', '1');
        return [before, x()];
      JS
      expect(value[0]).to eq(value[1])
      expect(diff['floatBand']).to eq(0), diff.inspect
      expect(diff['hit']).to be > 0, diff.inspect
    end

    it 'places a box anchored to a positioned row against the row it has NOW' do
      # A row (and a row group) gets its box only once every row is sized, at the end of `layoutTable` —
      # so it is never in `LAYING_OUT`, and a `bottom: 0` box anchored to a `position: relative` `<tr>`
      # resolved against whatever box the row had LAST pass: the initial containing block on the first
      # layout, and one pass behind on every later one. Rows are registered like cells now, so the child
      # is deferred and placed against the finished row. Chrome, the overlay's y in the table over the
      # sibling cell 40px → 100px → 40px: 30, 90, 30.
      %w[tr tbody].each do |tag|
        rows = tag == 'tr' ? '<tr id="r" style="position:relative">' : '<tbody id="r" style="position:relative"><tr>'
        close = tag == 'tr' ? '</tr>' : '</tr></tbody>'
        body = %(<table id="t" style="width:300px;border-spacing:0">#{rows}<td style="padding:0">x) +
               '<div id="ov" style="position:absolute;bottom:0;height:10px;width:10px"></div></td>' \
               "<td id=\"g\" style=\"padding:0;height:40px\"></td>#{close}</table>"
        s = session_for('', body)
        ys = s.evaluate_script(<<~JS)
          (() => {
            const y = () => document.getElementById('ov').getBoundingClientRect().y - document.getElementById('t').getBoundingClientRect().y;
            const out = [y()];
            for (const h of ['100px', '40px']) { document.getElementById('g').style.height = h; out.push(y()); }
            return out;
          })()
        JS
        expect(ys).to eq([30, 90, 30]), tag
      end

      # …and a STATIC-position box in such a row is deferred too, and moved by the cell's vertical-align shift
      # exactly ONCE: the shift's sweep of the pending list used to run again when the walk re-rooted on the
      # box's own stale out-of-flow rectangle, and a box with any inset then took the shift twice (82 where
      # the flow and native say 41). Both spellings — no inset, and a horizontal inset with a static vertical
      # position — answer what a fresh layout does, on every pass.
      ['', 'left:10%;'].each do |inset|
        st = ->(h) {
          %(<table id="t" style="width:300px;border-spacing:0"><tr style="position:relative"><td style="padding:0;vertical-align:middle">x) +
          %(<div id="st" style="position:absolute;#{inset}height:10px;width:10px"></div></td>) +
          "<td id=\"g\" style=\"padding:0;height:#{h}\"></td></tr></table>"
        }
        read = "document.getElementById('st').getBoundingClientRect().y - document.getElementById('t').getBoundingClientRect().y"
        fresh40  = session_for('', st.call('40px')).evaluate_script(read)
        fresh100 = session_for('', st.call('100px')).evaluate_script(read)
        expect(fresh100).to be > fresh40
        s2 = session_for('', st.call('40px'))
        got = s2.evaluate_script(<<~JS)
          (() => { const y = () => #{read}; const mm = () => globalThis.__csimLayoutShadowRun().mismatches;
            const out = [y()]; const before = mm();
            for (const h of ['100px', '40px', '100px']) { document.getElementById('g').style.height = h; out.push(y()); }
            out.push(mm() - before); return out; })()
        JS
        # …and the sequence adds no parity mismatch (the count is a DELTA: this helper's page keeps the UA
        # body margin, under which the two engines already disagree about the body's width)
        expect(got).to eq([fresh40, fresh100, fresh40, fresh100, 0]), inset
      end

      # …and a box hanging OFF the row reaches every ancestor's scroll extent, this pass: a `top: 100%`
      # dropdown under a positioned `<tr>` (implicit `<tbody>`) or `<tbody>`, and the same in an
      # `overflow: auto` scroller. It was flushed into the row's extent after the group had stamped its own,
      # and the cell above it had unioned the child's LAST pass's extent — so `scrollHeight` read 40 on the
      # first pass and one pass behind after. Chrome: 240, 300, 240, 300.
      {'tr' => ['<tr style="position:relative">', '</tr>'],
       'tbody' => ['<tbody style="position:relative"><tr>', '</tr></tbody>']}.each do |tag, (open, close)|
        dd = %(<table style="width:300px;border-spacing:0">#{open}<td style="padding:0">x) +
             '<div style="position:absolute;top:100%;height:200px;width:10px"></div></td>' \
             "<td id=\"g\" style=\"padding:0;height:40px\"></td>#{close}</table>"
        [['', 'document.body.scrollHeight'],
         ['<div id="sc" style="height:100px;overflow:auto">', "document.getElementById('sc').scrollHeight"]].each do |wrap, read|
          page = wrap.empty? ? dd : "#{wrap}#{dd}</div>"
          s3 = session_for('', page)
          hs = s3.evaluate_script(<<~JS)
            (() => { const h = () => #{read}; const out = [h()];
              for (const v of ['100px', '40px', '100px']) { document.getElementById('g').style.height = v; out.push(h()); }
              return out; })()
          JS
          expect(hs.map {|v| v - hs[0] + 240 }).to eq([240, 300, 240, 300]), "#{tag} #{read}"
          expect(hs[0]).to be >= 240, "#{tag} #{read}"
        end
      end
    end

    it 'moves a pending box by what the host between it and the root moves' do
      # `shiftPendingStatics` moved every entry under the root by the whole shift, but an out-of-flow HOST on
      # the way takes the shift only on the axes it has no inset for (the rule `shiftSubtree` applies to the
      # host itself), and an entry held under it moves with the host. A `position: fixed` box pending on a
      # transformed ancestor, under an absolute host with both insets, inside a middle-aligned cell: the
      # host never moves, so neither does the box. Chrome: y = 0 on every pass; a fresh layout agrees.
      body = '<div id="w" style="transform:translateX(0)"><div style="position:relative;height:200px">' \
             '<table style="border-spacing:0"><tr><td style="padding:0;vertical-align:middle">x' \
             '<div style="position:absolute;top:0;left:0;width:10px;height:10px">' \
             '<div id="b" style="position:fixed;left:0;width:10px;height:10px"></div></div></td>' \
             '<td id="g" style="padding:0;height:40px"></td></tr></table></div></div>'
      read = "document.getElementById('b').getBoundingClientRect().y - document.getElementById('w').getBoundingClientRect().y"
      fresh = session_for('', body.sub('height:40px', 'height:100px')).evaluate_script(read)
      s = session_for('', body)
      got = s.evaluate_script(<<~JS)
        (() => { const y = () => #{read}; const mm = () => globalThis.__csimLayoutShadowRun().mismatches;
          const out = [y()]; const before = mm();
          for (const h of ['100px', '40px', '100px']) { document.getElementById('g').style.height = h; out.push(y()); }
          out.push(mm() - before); return out; })()
      JS
      expect(got).to eq([0, fresh, 0, fresh, 0])
      expect(fresh).to eq(0)

      # …and the walk to the host goes up the FLAT tree, as `noteEscapingAbs` does: a host inside a shadow
      # root, with the pending box slotted through it, is not on the `_parent` chain. The light-DOM element
      # is a plain block here, so the shadow-side absolute box is the ONLY host between the box and the cell.
      # (Native declines a page with a shadow root, so this compares with Chrome's 0 rather than parity.)
      plain = body.sub('<div style="position:absolute;top:0;left:0;width:10px;height:10px">' \
                       '<div id="b" style="position:fixed;left:0;width:10px;height:10px"></div></div>', '<div></div>')
      expect(plain).not_to eq(body)
      s2 = session_for('', plain)
      got2 = s2.evaluate_script(<<~JS)
        (() => {
          const host = document.querySelector('td > div');
          host.attachShadow({mode: 'open'}).innerHTML = '<div style="position:absolute;top:0;left:0;width:10px;height:10px"><slot></slot></div>';
          const b = document.createElement('div');
          b.id = 'b';
          b.style.cssText = 'position:fixed;left:0;width:10px;height:10px';
          host.appendChild(b);
          const y = () => #{read};
          const out = [y()];
          for (const h of ['100px', '40px']) { document.getElementById('g').style.height = h; out.push(y()); }
          return out;
        })()
      JS
      expect(got2).to eq([0, 0, 0])
    end

    it 'lays a subtree out again when it holds a fixed box anchored to an element' do
      # `noteEscapingAbs` marks the boxes between an out-of-flow child and its containing block so none of
      # them is reused — and skipped a FIXED box unless it took a static position, on the reasoning that a
      # fixed box is placed from the viewport. One anchored to a transformed ELEMENT is not: its containing
      # block's origin and size are that element's, and with every inset given (no static position) the
      # cell holding it was reused and the box stayed where the row USED to end. Chrome and a fresh layout:
      # the box follows the row / the block on every pass.
      {'transformed tr' => ['<table id="t" style="border-spacing:0"><tr style="transform:translateX(0)"><td style="padding:0">x',
                            '</td><td id="g" style="padding:0;height:40px"></td></tr></table>', 'position:fixed;top:100%;left:0;width:10px;height:200px'],
       'transformed div' => ['<div id="t" style="transform:translateX(0)"><div><div style="height:40px">x',
                             '</div></div><div id="g" style="height:40px"></div></div>', 'position:fixed;bottom:0;left:0;width:10px;height:10px']
      }.each do |label, (open, close, style)|
        page = ->(h) { "#{open}<div id=\"f\" style=\"#{style}\"></div>#{close.sub('height:40px', "height:#{h}")}" }
        read = "document.getElementById('f').getBoundingClientRect().y - document.getElementById('t').getBoundingClientRect().y"
        fresh40  = session_for('', page.call('40px')).evaluate_script(read)
        fresh100 = session_for('', page.call('100px')).evaluate_script(read)
        expect(fresh100).to be > fresh40
        s = session_for('', page.call('40px'))
        value, diff = stats_around(s, <<~JS)
          const y = () => #{read}; const out = [y()];
          for (const h of ['100px', '40px']) { document.getElementById('g').style.height = h; out.push(y()); }
          return out;
        JS
        expect(value).to eq([fresh40, fresh100, fresh40]), label
        expect(diff['escapingAbs']).to be > 0, label
      end
    end

    it 'dirties the SHADOW boxes that lay out slotted light DOM' do
      # The dirty walk goes up the FLAT tree, because that is the chain of boxes that lays a node
      # out: `#pad`'s parent box is the `<slot>`, then `#wrap`, then the host. Walking the node
      # tree instead jumped straight from `#pad` to the host and left `#wrap` clean, so it handed
      # its stale box back on every pass — the write moved nothing at all, for good.
      s = session_for('', '<div id="host"><div id="pad" style="height: 20px"></div></div>')
      got = s.evaluate_script(<<~JS)
        (() => {
          const host = document.getElementById('host');
          host.attachShadow({mode: 'open'}).innerHTML = '<div id="wrap"><slot></slot></div>';
          const wrap = host.shadowRoot.getElementById('wrap');
          const pad = document.getElementById('pad');
          const h = () => [wrap.getBoundingClientRect().height, pad.getBoundingClientRect().height];
          const before = h();
          pad.style.height = '200px';
          return before.concat(h());
        })()
      JS
      expect(got).to eq([20, 20, 200, 200])
    end

    it 'does the same through a CLOSED shadow root' do
      # Which boxes lay a node out cannot depend on the root's MODE. The public `assignedSlot` is
      # open-only, so taking the flat-tree parent from it left a closed root's boxes stale — the
      # exact bug above, hidden behind `mode: 'closed'`.
      s = session_for('', '<div id="host"><div id="pad" style="height: 20px"></div></div>')
      got = s.evaluate_script(<<~JS)
        (() => {
          const host = document.getElementById('host');
          const root = host.attachShadow({mode: 'closed'});
          root.innerHTML = '<div id="wrap"><slot></slot></div>';
          const wrap = root.getElementById('wrap');
          const pad = document.getElementById('pad');
          const h = () => [wrap.getBoundingClientRect().height, pad.getBoundingClientRect().height];
          const before = h();
          pad.style.height = '200px';
          return before.concat(h());
        })()
      JS
      expect(got).to eq([20, 20, 200, 200])
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
      # …while the removal really did land: the 200px box goes, and the last paragraph's bottom
      # margin then COLLAPSES OUT of the body it was holding apart from it (Chrome: 268 -> 52).
      expect(value[3]).to eq(value[1] - 216)
      expect(diff['hit']).to eq(1)
      expect(diff.values_at('escapingAbs', 'remeasured')).to eq([0, 0])
    end
  end

  # A border-collapse cell's border is grid-resolved — as wide as the widest of the two borders facing
  # across each shared edge — so a SIBLING's border change moves THIS cell even though the cell itself
  # was never touched. The per-cell edge / intrinsic-width memos key on the cell's own dirty stamp, which
  # a sibling mutation does not bump (only the table, an ancestor of both, is dirtied); `collapseDepStamp`
  # folds the table's stamp into their freshness so the facing cell re-lays-out. Chrome: c1 goes 66 -> 76
  # when c2's border-left grows 6 -> 30 (c1's shared edge = max(10, 30)/2 = 15, so 60 + 1 + 15).
  it "updates a collapsed cell when a facing sibling cell's border changes" do
    s = session_for('', '<table style="border-collapse:collapse"><tr>' \
      '<td id="c1" style="border-left:2px solid;border-right:10px solid;width:60px;padding:0">a</td>' \
      '<td id="c2" style="border-left:6px solid;border-right:4px solid;width:80px;padding:0">b</td></tr></table>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const w = () => document.getElementById('c1').getBoundingClientRect().width;
        const before = w();
        document.getElementById('c2').style.borderLeftWidth = '30px';   // the edge c1 FACES
        return [before, w()];
      })()
    JS
    expect(got).to eq([66, 76])
  end

  # The same cross-cell dependency reaches the SUBTREE-reuse path: when a facing sibling's border grows, a
  # fixed-layout border-box cell keeps its (pinned) border box but its CONTENT box shrinks, so its children
  # must re-flow. reuseSubtree is keyed on the cell's own stamp (unchanged by a sibling mutation) and the
  # border box (unchanged here), so without the collapse-dep guard it would hand back the child's stale box.
  # Chrome: the child goes 100 -> 85 as the neighbour's border-left grows 0 -> 30 (200 - 2*100 border-box,
  # the 30px collapsed border eating into this cell's content).
  it "re-flows a collapsed cell's children when a facing sibling's border changes its content box" do
    s = session_for('', '<table style="border-collapse:collapse;table-layout:fixed;width:200px"><tr>' \
      '<td id="x" style="box-sizing:border-box;width:100px;padding:0;border:0"><div id="c">c</div></td>' \
      '<td id="y" style="box-sizing:border-box;width:100px;padding:0;border:0">y</td></tr></table>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const w = () => document.getElementById('c').getBoundingClientRect().width;
        const before = w();
        document.getElementById('y').style.borderLeft = '30px solid';   // eats into x's content box
        return [before, w()];
      })()
    JS
    expect(got).to eq([100, 85])
  end

  # The FLAT tree can change shape with no mutation under the boxes it moves: a slot's assigned set changes when a
  # light child's `slot` attribute does, when `assign()` is called, or when the light child goes — and the boxes that
  # hold the slot live in the SHADOW tree, above no node any of those mutations stamps. `signalSlotChange` marks the
  # slot's subtree and its flat-tree spine. Without it both layouts kept the old flat tree: a span renamed out of the
  # 100px slot stayed where it was, and a manually assigned span or a removed one never moved the box after it.
  describe 'slot assignment' do
    def slotted_session(body, script)
      s = session_for('body { margin: 0 }', body)
      s.execute_script(script)
      s.evaluate_script('document.body.offsetHeight')   # a first layout, so a cache that never fills cannot pass
      s
    end

    it 'relays out the shadow boxes when a slot attribute moves a child to another slot' do
      s = slotted_session(
        '<div id="h"><span slot="a" id="sa">aaaa bbbb cccc dddd eeee ffff</span><span slot="b" id="sb">x</span></div>',
        "document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = " \
          "'<div style=\"width:100px\"><slot name=\"a\"></slot></div>" \
          "<div style=\"width:400px;font-size:20px\"><slot name=\"b\"></slot></div>'"
      )
      rect = <<~JS
        (() => {
          const r = document.getElementById('sa').getBoundingClientRect();
          return [r.x, r.y, r.height];
        })()
      JS
      expect(s.evaluate_script(rect)).to eq([0, 0, 35])    # two lines in the 100px box (Chrome: 0, 0, 35)
      s.execute_script("document.getElementById('sa').slot = 'b'")
      expect(s.evaluate_script(rect)).to eq([0, 0, 22])    # one 20px line in the 400px box (Chrome: 0, 0, 22)
      s.execute_script("document.getElementById('sa').slot = 'a'; document.getElementById('sb').slot = 'a'")
      expect(s.evaluate_script(rect)).to eq([0, 0, 35])    # back in the 100px box (Chrome: 0, 0, 35)
    end

    it 'relays out after assign() and after a slotted child is removed' do
      s = slotted_session(
        '<div id="h"><span id="x1">aaaa bbbb cccc dddd</span></div><div id="h2"><span id="y1">aaaa bbbb cccc dddd</span></div>',
        <<~JS
          const sr = document.getElementById('h').attachShadow({mode: 'open', slotAssignment: 'manual'});
          sr.innerHTML = '<div style="width:100px"><slot></slot></div><div id="tail" style="height:5px"></div>';
          const sr2 = document.getElementById('h2').attachShadow({mode: 'open'});
          sr2.innerHTML = '<div style="width:100px"><slot></slot></div><div id="tail" style="height:5px"></div>';
        JS
      )
      tails = <<~JS
        [document.getElementById('h'), document.getElementById('h2')].map((h) => h.shadowRoot.getElementById('tail').getBoundingClientRect().y)
      JS
      expect(s.evaluate_script(tails)).to eq([0, 41])      # nothing assigned yet; two lines in the second host (Chrome)
      s.execute_script("document.getElementById('h').shadowRoot.querySelector('slot').assign(document.getElementById('x1'))")
      expect(s.evaluate_script(tails)).to eq([36, 77])     # (Chrome: 36, 77)
      s.execute_script("document.getElementById('y1').remove()")
      expect(s.evaluate_script(tails)).to eq([36, 41])     # (Chrome: 36, 41)
    end

    # …and the node that LEAVES the flat tree: nothing above it is marked (its old slot's spine is not its spine any
    # more), and "rendered" was asked up the NODE tree, to the host — so its old box kept answering. Chrome: an empty
    # rect, offsetHeight 0, no client rects, `checkVisibility()` false and no hit, for all three ways out.
    it 'drops the box of a child no slot takes any more' do
      {
        "document.getElementById('sa').removeAttribute('slot')"      => '<div style="width:100px"><slot name="a"></slot></div>',
        "document.getElementById('h').shadowRoot.getElementById('s').remove()" => '<div style="width:100px"><slot id="s" name="a"></slot></div>',
        "document.getElementById('h').shadowRoot.getElementById('s').assign()" => '<div style="width:100px"><slot id="s"></slot></div>'
      }.each do |leave, shadow|
        manual = leave.include?('assign')
        attach = "const sr = document.getElementById('h').attachShadow({mode: '#{manual ? "open', slotAssignment: 'manual" : 'open'}'}); " \
                 "sr.innerHTML = '#{shadow}';"
        attach += " sr.getElementById('s').assign(document.getElementById('sa'));" if manual
        s = slotted_session('<div id="h"><span id="sa" slot="a">aaaa bbbb</span></div>', attach)
        read = <<~JS
          (() => {
            const sa = document.getElementById('sa'), r = sa.getBoundingClientRect(), hit = document.elementFromPoint(5, 5);
            return [[r.x, r.y, r.width, r.height], sa.offsetHeight, sa.getClientRects().length, sa.checkVisibility(), hit === sa];
          })()
        JS
        expect(s.evaluate_script(read)).to eq([[0, 0, 64.40625, 17], 17, 1, true, true]), leave
        s.execute_script(leave)
        expect(s.evaluate_script(read)).to eq([[0, 0, 0, 0], 0, 0, false, false]), leave
      end
    end

    # …and a slot's own children are its FALLBACK, rendered only while nothing is assigned to it. Chrome: the fallback of
    # the slot the span is in is not visible, the other slot's is — and they trade places when the span moves.
    it 'renders a slot fallback only while nothing is assigned to the slot' do
      s = slotted_session(
        '<div id="h"><span id="sa" slot="a">x</span></div>',
        "document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = " \
          "'<slot name=\"a\"><span id=\"fb\">fallback</span></slot><slot name=\"b\"><span id=\"fb2\">fallback2</span></slot>'"
      )
      read = <<~JS
        ['fb', 'fb2'].map((id) => {
          const e = document.getElementById('h').shadowRoot.getElementById(id);
          return [e.checkVisibility(), e.getBoundingClientRect().height, e.offsetHeight, e.getClientRects().length];
        })
      JS
      expect(s.evaluate_script(read)).to eq([[false, 0, 0, 0], [true, 17, 17, 1]])
      s.execute_script("document.getElementById('sa').slot = 'b'")
      expect(s.evaluate_script(read)).to eq([[true, 17, 17, 1], [false, 0, 0, 0]])
    end

    # `visibility` inherits through the FLAT tree, like every inherited property: a slotted span under a `visibility:
    # hidden` shadow box is hidden (Chrome) — though a bare `checkVisibility()`, which does not ask about `visibility`,
    # still says true.
    it 'inherits visibility into slotted content' do
      s = slotted_session(
        '<div id="h"><span id="sa">x</span></div>',
        "document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = '<div style=\"visibility:hidden\"><slot></slot></div>'"
      )
      got = s.evaluate_script(<<~JS)
        (() => {
          const e = document.getElementById('sa');
          return [e.checkVisibility({visibilityProperty: true}), getComputedStyle(e).visibility, e.checkVisibility()];
        })()
      JS
      expect(got).to eq([false, 'hidden', true])
    end

    # Attaching a shadow root takes every light child out of the flat tree, with no DOM mutation to say so (Chrome: the
    # element after a 50px child moves up to 0 at once, and back down once a slot takes it).
    it 'relays out a host when a shadow root is attached to it' do
      s = slotted_session('<div id="h"><div style="height:50px"></div></div><div id="after"></div>', 'void 0')
      y = "document.getElementById('after').getBoundingClientRect().y"
      expect(s.evaluate_script(y)).to eq(50)
      s.execute_script("window.sr = document.getElementById('h').attachShadow({mode: 'open'})")
      expect(s.evaluate_script(y)).to eq(0)
      s.execute_script("sr.innerHTML = '<slot></slot>'")
      expect(s.evaluate_script(y)).to eq(50)
    end
  end

  # A parser-blocking script that reads geometry lays out the PARTIAL tree, and the parse goes on under the boxes it
  # laid out — with nothing observing, the parser records no mutation, so `#c` (parsed after that read) had no box at
  # all and the body stayed 18 tall. Chrome: y 68, offsetTop 68, the body 86, `#c` 18 tall.
  it 'lays out what the parser inserted after a script read the layout' do
    s = session_for(
      'body { margin: 0 }',
      '<div style="width:300px"><p id="b" style="margin:0">123</p>' \
        "<script>window.r = [document.getElementById('b').getBoundingClientRect().y]</script>" \
        '<div style="height:50px"></div><p id="c" style="margin:0">c</p>' \
        "<script>const c = document.getElementById('c'); " \
        'r.push(c.getBoundingClientRect().y, c.offsetTop, document.body.offsetHeight, c.getBoundingClientRect().height)</script></div>'
    )
    expect(s.evaluate_script('r')).to eq([0, 68, 68, 86, 18])
  end

  # …and a `dir=auto` scope the parse writes strong text into is tested where the direction is next READ — layout or
  # getComputedStyle — against the direction the cascade last laid it out with. A `:dir()` read in between resolved it
  # too, and when that refreshed the baseline the flip was never seen (a native pass replayed the stale box). Chrome:
  # `[0, true, 200]`, and getComputedStyle `ltr` then `rtl` with no layout read at all.
  it 'turns a dir=auto scope around when the parse writes strong text into it' do
    body = ->(read) { %(<div id="d" dir="auto" style="width:300px"><p id="b" style="width:100px;margin:0">123</p><script>window.r = [#{read}]</script>&#x5e9;&#x5dc;&#x5d5;&#x5dd;</div>) }
    s = session_for('body { margin: 0 }', body.call("document.getElementById('b').getBoundingClientRect().x"))
    got = s.evaluate_script("[r[0], document.getElementById('d').matches(':dir(rtl)'), document.getElementById('b').getBoundingClientRect().x]")
    expect(got).to eq([0, true, 200])
    s = session_for('body { margin: 0 }', body.call("getComputedStyle(document.getElementById('b')).direction"))
    expect(s.evaluate_script("[r[0], getComputedStyle(document.getElementById('b')).direction]")).to eq(%w[ltr rtl])
  end

  # `dir="auto"` takes its direction from the first strong character of its text, and every box under it inherits that.
  # `markDirAutoScopes` marks the auto element's subtree when its resolved direction FLIPS — without it the sibling kept
  # its left-to-right box in both layouts.
  describe 'dir=auto' do
    def x_after(body, change, shadow: nil)
      s = session_for('body { margin: 0 }', body)
      s.execute_script("document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = '#{shadow}'") if shadow
      x = "document.getElementById('b').getBoundingClientRect().x"
      [s.evaluate_script(x), (s.execute_script(change) || s.evaluate_script(x))]
    end

    it 'turns the other children around when a text edit flips the direction' do   # Chrome: 0 -> 200
      body = '<div dir="auto" style="width:300px"><p id="a">hello</p><div><p id="b" style="width:100px">sibling</p></div></div>'
      expect(x_after(body, "document.getElementById('a').textContent = 'שלום עולם'")).to eq([0, 200])
    end

    # …up the FLAT tree: a `<slot dir=auto>` resolves from its ASSIGNED text, which a node-tree walk never reaches.
    # (This one and the next the JS layout answered right by accident; a native pass REPLAYED the stale subtree, which
    # `CSIM_NL_REUSE_VERIFY=1` turns into a throw.)
    it 'flips a dir=auto slot when its slotted text changes' do   # Chrome: 0 -> 200
      body = '<div id="h"><span id="a">hello</span><p id="b" style="width:100px;margin:0">x</p></div>'
      shadow = '<div style="width:300px"><slot dir="auto" style="display:block"></slot></div>'
      expect(x_after(body, "document.getElementById('a').firstChild.data = 'שלום'", shadow: shadow)).to eq([0, 200])
    end

    # A `dir=auto` INSIDE the scope resolves through its host (its slotted text) — which must not count as the host's
    # own resolution, or the host's flip is seen as no flip. Chrome: 0 -> 200 (a native pass replayed the stale box).
    it 'flips a dir=auto host whose shadow tree holds another dir=auto' do
      body = '<div id="h" dir="auto" style="width:300px"><span id="a">hello</span></div>'
      s = session_for('body { margin: 0 }', body)
      s.execute_script("document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = " \
                       "'<div dir=\"auto\"><slot></slot></div><p id=\"b\" style=\"width:100px;margin:0\">x</p>'")
      x = "document.getElementById('h').shadowRoot.getElementById('b').getBoundingClientRect().x"
      expect(s.evaluate_script(x)).to eq(0)
      s.execute_script("document.getElementById('a').firstChild.data = '\\u05e9\\u05dc\\u05d5\\u05dd'")
      expect(s.evaluate_script(x)).to eq(200)
    end

    # A descendant's own `dir` takes its text out of the scan (and removing it puts the text back). (The Hebrew is written
    # as references: the page is served with no charset.)
    it 'flips when a descendant gains or loses a dir of its own' do   # Chrome: 200 -> 0, and 0 -> 200
      expect(x_after('<div dir="auto" style="width:300px"><span id="a">&#x5e9;&#x5dc;&#x5d5;&#x5dd;</span><p id="b" style="width:100px;margin:0">x</p></div>',
                     "document.getElementById('a').setAttribute('dir', 'ltr')")).to eq([200, 0])
      expect(x_after('<div dir="auto" style="width:300px"><span id="a" dir="ltr">&#x5e9;&#x5dc;&#x5d5;&#x5dd;</span><p id="b" style="width:100px;margin:0">x</p></div>',
                     "document.getElementById('a').removeAttribute('dir')")).to eq([0, 200])
    end

    # …and only when it FLIPS: marking every edit's auto ancestor anyway cost a `<body dir=auto>` page every memo in
    # the document per text edit (6x on 3,000 elements). A COUNT, not a wall — `__csimSubtreeMarks`.
    it 'leaves the subtree alone when an edit does not flip the direction' do
      s = session_for('', '<div dir="auto"><span id="a">hello</span><p>x</p></div>')
      marks = lambda do |change|
        s.evaluate_script(<<~JS)
          (() => {
            document.body.offsetHeight;
            const m = __csimSubtreeMarks();
            #{change};
            document.body.offsetHeight;
            return __csimSubtreeMarks() - m;
          })()
        JS
      end
      expect(marks.call("document.getElementById('a').firstChild.data = 'world'")).to eq(0)
      expect(marks.call("document.getElementById('a').firstChild.data = 'שלום'")).to be > 0
    end
  end
end
