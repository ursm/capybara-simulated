# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The declared-value memo's STRUCTURAL-CONTEXT key (cascade.js `ctxEpochOf`): an attribute write
# on an ancestor re-keys a descendant only as far as the stylesheet reads that identifier there —
# the subjects of the rules that name it in a non-subject compound (a sweep), the siblings a
# sibling combinator reaches, the custom properties a substitution read (per-name generations) —
# and leaves every other descendant's memo alone. Each correctness example below held before the
# gate (every write re-keyed the whole subtree); the two "leaves … alone" examples are the contract
# the gate adds.
RSpec.describe 'structural-context invalidation' do
  def page(css, body)
    lambda {|_env|
      [200, {'content-type' => 'text/html'},
       ["<!DOCTYPE html><html><head><style>#{css}</style></head><body>#{body}</body></html>"]]
    }
  end

  def colors(css, body, script)
    s = simulated_session(page(css, body))
    s.visit '/'
    s.evaluate_script(<<~JS)
      (() => {
        const color = (id) => getComputedStyle(document.getElementById(id)).color;
        #{script}
      })()
    JS
  end

  it 'restyles the subjects of an ancestor-keyed rule when the ancestor gains the class' do
    got = colors('.on .x { color: rgb(0, 128, 0) }', '<div id="a"><p id="x" class="x">x</p><p id="y">y</p></div>', <<~JS)
      const before = [color('x'), color('y')];
      document.getElementById('a').className = 'on';
      return [before, [color('x'), color('y')]];
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 128, 0)', 'rgb(0, 0, 0)']])
  end

  it 'restyles through :not() in a non-subject compound' do
    got = colors('div:not(.off) .x { color: rgb(0, 128, 0) }', '<div id="a"><p id="x" class="x">x</p></div>', <<~JS)
      const before = color('x');
      document.getElementById('a').className = 'off';
      return [before, color('x')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  it 'restyles a substitution when an ancestor rule declaring the custom property starts matching' do
    got = colors('.dark { --c: rgb(0, 128, 0) } .x { color: var(--c, rgb(0, 0, 255)) }', '<div id="a"><p id="x" class="x">x</p></div>', <<~JS)
      const before = color('x');
      document.getElementById('a').className = 'dark';
      return [before, color('x')];
    JS
    expect(got).to eq(['rgb(0, 0, 255)', 'rgb(0, 128, 0)'])
  end

  it 'restyles a substitution when an ancestor INLINE custom property changes, without re-keying the subtree' do
    got = colors('.x { color: var(--c, rgb(0, 0, 255)) }', '<div id="a" style="--c: rgb(0, 128, 0)"><p id="x" class="x">x</p><p id="y">y</p></div>', <<~JS)
      const before = color('x');
      const y = document.getElementById('y');
      getComputedStyle(y).color;                               // prime y's memo
      const ctxBefore = globalThis.__csimCtxEpoch(y);
      document.getElementById('a').style.setProperty('--c', 'rgb(255, 0, 0)');
      return [before, color('x'), globalThis.__csimCtxEpoch(y) === ctxBefore, globalThis.__csimCtxGateActive()];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(255, 0, 0)', true, true])
  end

  it "sweeps an ancestor rule's subjects instead of re-keying the subtree" do
    # The mechanism, not just the outcome: `.on .x` names a subject, so the write re-keys the
    # elements matching `.x` under the writer (one sweep) and leaves every other descendant's
    # context — and therefore its memo — where it was.
    css  = '.on .x { color: rgb(0, 128, 0) }'
    body = '<div id="a"><p id="x" class="x">x</p><p id="y">y</p></div>'
    got = colors(css, body, <<~JS)
      const y = document.getElementById('y');
      color('x'); color('y');
      const sweeps = globalThis.__csimCtxSweeps(), yCtx = globalThis.__csimCtxEpoch(y);
      document.getElementById('a').className = 'on';
      const after = color('x');                                    // the read runs the pending sweep
      return [after, globalThis.__csimCtxSweeps() - sweeps, globalThis.__csimCtxEpoch(y) === yCtx];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 1, true])
  end

  it 'leaves a descendant alone when an ancestor gains a class no rule reads in an ancestor position' do
    got = colors('.zzz { color: rgb(0, 128, 0) } .x { color: rgb(0, 0, 255) }', '<div id="a"><p id="x" class="x">x</p></div>', <<~JS)
      const x = document.getElementById('x');
      color('x');
      const ctxBefore = globalThis.__csimCtxEpoch(x);
      document.documentElement.className = 'zzz';
      document.getElementById('a').className = 'zzz';
      return [globalThis.__csimCtxEpoch(x) === ctxBefore, color('x'), globalThis.__csimCtxGateActive()];
    JS
    expect(got).to eq([true, 'rgb(0, 0, 255)', true])
  end

  it 'restyles the later sibling of a sibling-combinator rule, and its subtree for a deep one' do
    css  = '.a + .b { color: rgb(0, 128, 0) } .a ~ .d .e { color: rgb(0, 0, 255) }'
    body = '<div><p id="p">p</p><p id="b" class="b">b</p><div class="d"><span id="e" class="e">e</span></div></div>'
    got = colors(css, body, <<~JS)
      const before = [color('b'), color('e')];
      document.getElementById('p').className = 'a';
      return [before, [color('b'), color('e')]];
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 128, 0)', 'rgb(0, 0, 255)']])
  end

  it 'restyles under a positional non-subject compound when a child is inserted' do
    got = colors('li:first-child a { color: rgb(0, 128, 0) }', '<ul id="u"><li><a id="x">x</a></li></ul>', <<~JS)
      const before = color('x');
      const li = document.createElement('li');
      li.innerHTML = '<a>new</a>';
      document.getElementById('u').insertBefore(li, document.getElementById('u').firstChild);
      return [before, color('x')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  it 'restyles a sibling of an element whose emptiness changes' do
    got = colors('.e:empty + .x { color: rgb(0, 128, 0) }', '<div><div id="e" class="e"></div><p id="x" class="x">x</p></div>', <<~JS)
      const before = color('x');
      document.getElementById('e').appendChild(document.createTextNode('t'));
      return [before, color('x')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  it 'restyles the subjects of an ancestor attribute selector and id' do
    css  = '[data-theme="dark"] .x { color: rgb(0, 128, 0) } #root .y { color: rgb(0, 0, 255) }'
    body = '<div id="a"><p id="x" class="x">x</p><p id="y" class="y">y</p></div>'
    got = colors(css, body, <<~JS)
      const before = [color('x'), color('y')];
      const a = document.getElementById('a');
      a.setAttribute('data-theme', 'dark');
      a.id = 'root';
      return [before, [color('x'), color('y')]];
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 128, 0)', 'rgb(0, 0, 255)']])
  end

  # The five below are review counter-examples: each went stale on the gate's first cut.
  it 'lets a rule added after an ancestor gained its class see that class' do
    got = colors('.q .x { color: rgb(255, 0, 0) } .x { color: rgb(0, 0, 255) }', '<div id="a"><p id="x" class="x">x</p></div>', <<~JS)
      const before = color('x');                                   // primes x's ancestor bloom
      document.getElementById('a').className = 'zzz';             // no rule reads .zzz yet: x keeps its context
      const style = document.createElement('style');
      style.textContent = '.zzz .x { color: rgb(0, 128, 0) }';
      document.head.appendChild(style);
      return [before, color('x')];
    JS
    expect(got).to eq(['rgb(0, 0, 255)', 'rgb(0, 128, 0)'])
  end

  it 'restyles the subjects of an ancestor [class*=] / [id^=] selector' do
    css  = '[class*="on-"] .x { color: rgb(0, 128, 0) } [id^="r"] .y { color: rgb(0, 0, 255) }'
    body = '<div id="a"><p id="x" class="x">x</p><p id="y" class="y">y</p></div>'
    got = colors(css, body, <<~JS)
      const before = [color('x'), color('y')];
      const a = document.getElementById('a');
      a.className = 'on-x';
      a.id = 'root';
      return [before, [color('x'), color('y')]];
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 128, 0)', 'rgb(0, 0, 255)']])
  end

  it 'restyles a deep sibling-combinator subject when the left sibling is inserted, moved or removed' do
    css  = '.a ~ .d .e { color: rgb(0, 128, 0) } .a ~ .d { --c: rgb(0, 0, 255) } .f { color: var(--c, rgb(0, 0, 0)) }'
    body = '<div id="p"><div class="d"><span id="e" class="e">e</span><span id="f" class="f">f</span></div></div>'
    got = colors(css, body, <<~JS)
      const p = document.getElementById('p'), d = p.firstElementChild;
      const before = [color('e'), color('f')];
      const a = document.createElement('p'); a.className = 'a';
      p.insertBefore(a, d);
      const inserted = [color('e'), color('f')];
      p.appendChild(a);                                            // moved AFTER .d: no longer precedes it
      const moved = [color('e'), color('f')];
      p.insertBefore(a, d);
      p.removeChild(a);
      return [before, inserted, moved, [color('e'), color('f')]];
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 128, 0)', 'rgb(0, 0, 255)'], ['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(0, 0, 0)', 'rgb(0, 0, 0)']])
  end

  it 'resolves the flow-relative twin again when the inherited direction flips' do
    got = colors('.x { margin-inline-start: 10px }', '<div id="a" dir="rtl"><p id="x" class="x">x</p></div>', <<~JS)
      const x = document.getElementById('x');
      const m = () => [getComputedStyle(x).marginLeft, getComputedStyle(x).marginRight];
      const before = m();
      document.getElementById('a').removeAttribute('dir');
      return [before, m()];
    JS
    expect(got).to eq([['0px', '10px'], ['10px', '0px']])
  end

  it 'carries an inherited input through a memo HIT into the enclosing compute' do
    css  = '.p { font-size: var(--fs) } .x { width: calc(2em) }'
    body = '<div id="a" style="--fs: 10px"><div id="p" class="p"><p id="x" class="x">x</p></div></div>'
    got = colors(css, body, <<~JS)
      const x = document.getElementById('x');
      getComputedStyle(document.getElementById('p')).fontSize;    // primes p's font-size memo
      const before = getComputedStyle(x).width;                    // its em basis is that hit
      document.getElementById('a').style.setProperty('--fs', '20px');
      return [before, getComputedStyle(x).width];
    JS
    expect(got).to eq(['20px', '40px'])
  end

  it 'reaches a sibling subtree through a sibling-keyed positional declaration' do
    css  = '.e:empty + .x { --c: rgb(0, 128, 0) } .x span { color: var(--c, rgb(0, 0, 0)) }'
    body = '<div><div id="e" class="e"></div><p class="x"><span id="s">s</span></p></div>'
    got = colors(css, body, <<~JS)
      const before = color('s');
      document.getElementById('e').appendChild(document.createTextNode('t'));
      return [before, color('s')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  it 'restyles a sibling through :not(:empty) left of a sibling combinator' do
    got = colors('.e:not(:empty) + .x { color: rgb(0, 128, 0) }', '<div><div id="e" class="e"></div><p id="x" class="x">x</p></div>', <<~JS)
      const before = color('x');
      document.getElementById('e').appendChild(document.createTextNode('t'));
      return [before, color('x')];
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'does not keep a mid-parse context once the parser has moved on' do
    # A `<script>` that reads style while the parser is still appending its siblings: the parser
    # moves no settleGen, so the context memo keys on the parser tree generation too.
    app = lambda {|_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>p:nth-last-child(2) { color: rgb(0, 128, 0) }</style></head>
        <body><p id="x">x</p><script>window.__mid = getComputedStyle(document.getElementById('x')).color;</script><p>y</p><p>z</p></body></html>
      HTML
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script('[window.__mid, getComputedStyle(document.getElementById("x")).color]')
    # mid-parse: x + script = 2 children, x is nth-last-child(2) → green; after: x is 4th from last
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  it 'restyles :disabled controls when their fieldset is disabled' do
    got = colors('input:disabled { color: rgb(0, 128, 0) }', '<fieldset id="f"><input id="i"></fieldset>', <<~JS)
      const before = color('i');
      document.getElementById('f').disabled = true;
      return [before, color('i')];
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  # A text edit can move a selector's match only through `:empty` — the one thing a selector reads of text — so one that
  # neither empties an element nor fills an empty one re-keys nothing: every keystroke in a Redmine table cell used to
  # re-key the cell, its whole subtree and its row's, and a relayout recomputed their declared values from the rules.
  # Emptying it (the `.e:empty + i` flip) still re-keys, and the sibling still restyles.
  it 'leaves the context alone for a text edit that cannot flip :empty' do
    got = colors('li:first-child span { color: rgb(0, 0, 255) } .e:empty + i { color: rgb(0, 128, 0) }',
                 '<ul><li><span id="s">a</span></li></ul><div><b class="e" id="e">x</b><i id="i">i</i></div>', <<~JS)
      const s = document.getElementById('s'), e = document.getElementById('e');
      const ctx = (el) => __csimCtxEpoch(el);
      const s0 = ctx(s), e0 = ctx(e);
      s.firstChild.data = 'ab'; e.firstChild.data = 'xy';
      const kept = [ctx(s) === s0, ctx(e) === e0];
      e.firstChild.data = '';
      return [kept, ctx(e) !== e0, color('i')];
    JS
    expect(got).to eq([[true, true], true, 'rgb(0, 128, 0)'])
  end

  # …and the same for a child-list change: all a sibling's selector reads of this child list is `:empty`. On a page with a
  # deep one (`.e:empty ~ .d i`), every append to an element with children re-keyed its PARENT's subtree — an append to a
  # `<body>` the whole document, which a jQuery support test's probe did four times per Redmine page load.
  it 'leaves the siblings alone for a child-list change that cannot flip :empty' do
    got = colors('.e:empty ~ .d i { color: rgb(0, 128, 0) }',
                 '<div><b class="e" id="e">x</b><div class="d"><i id="i">i</i></div></div>', <<~JS)
      const e = document.getElementById('e'), i = document.getElementById('i');
      const before = color('i'), i0 = __csimCtxEpoch(i);
      e.appendChild(document.createElement('u'));
      e.lastChild.remove();
      const kept = __csimCtxEpoch(i) === i0;
      e.firstChild.remove();
      return [before, kept, color('i'), __csimCtxGateActive()];
    JS
    expect(got).to eq(['rgb(0, 0, 0)', true, 'rgb(0, 128, 0)', true])
  end

  # A child-list change re-keys the children a position is read of, not every child beside the change point: one no
  # compound that reads a position can match — `tr` here, or any child of a `.c` — keeps its context.
  it 'leaves the context of a neighbour no positional compound can match' do
    got = colors('.s tr:first-child td { color: rgb(0, 0, 255) } .c > *:last-child b { color: rgb(0, 128, 0) }',
                 '<div id="w"><p id="p"><b id="b">b</b></p></div><div class="c" id="c"><p><b id="x">x</b></p></div>', <<~JS)
      const b = document.getElementById('b'), w = document.getElementById('w');
      const before = color('x'), b0 = __csimCtxEpoch(b);
      w.prepend(document.createElement('i'));
      w.append(document.createElement('i'));
      const kept = __csimCtxEpoch(b) === b0;
      document.getElementById('c').append(document.createElement('i'));
      return [before, kept, color('x')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', true, 'rgb(0, 0, 0)'])
  end

  # …and a sibling run behind a position read from the END is reached from BEFORE the change point: appending after
  # `.y` makes `.x` no longer second from the end.
  it 'restyles a sibling run behind an :nth-last-child() when a child is appended after it' do
    got = colors('.x:nth-last-child(2) + .y span { color: rgb(0, 128, 0) }',
                 '<div id="d"><p class="x">x</p><div class="y"><span id="s">s</span></div></div>', <<~JS)
      const before = color('s');
      document.getElementById('d').append(document.createElement('i'));
      return [before, color('s')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  # …and so is one behind a `:last-of-type`, whose flip the of-type walk (the nearest element of the changed type) never
  # carries on to the run.
  it 'restyles a sibling run behind a :last-of-type when one of its type is appended' do
    got = colors('p.x:last-of-type ~ .y span { color: rgb(0, 128, 0) }',
                 '<div id="d"><p class="x">x</p><div class="y"><span id="s">s</span></div></div>', <<~JS)
      const before = color('s');
      document.getElementById('d').append(document.createElement('p'));
      return [before, color('s')];
    JS
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  # …but a memo that is NOT the declared-value one has to decline it too: the flow sides a `margin-inline-start` maps
  # through were kept while a `:has()` flipped `direction`, and the physical margin stayed on the left (Chrome: right) —
  # by a class write and by an insertion alike.
  it 'maps flow-relative sides through a direction a :has() flips' do
    css  = '.p:has(.flag) .c { direction: rtl } .c { margin-inline-start: 50px; display: block }'
    body = '<div class="p" id="p"><i id="f"></i><div class="c" id="s">x</div></div>'
    margins = <<~JS
      const sides = () => { const cs = getComputedStyle(document.getElementById('s')); return [cs.direction, cs.marginLeft, cs.marginRight]; };
    JS
    by_class = colors(css, body, margins + "const a = sides(); document.getElementById('f').className = 'flag'; return [a, sides()];")
    by_insert = colors(css, body, margins + "const a = sides(); const i = document.createElement('i'); i.className = 'flag'; " \
                                            "document.getElementById('p').prepend(i); return [a, sides()];")
    expect([by_class, by_insert]).to all(eq([['ltr', '50px', '0px'], ['rtl', '0px', '50px']]))
  end

  # A `:has()` reads DOWNWARD, which no context epoch can see: a read that considered its rule is never memoised, so what
  # its argument names has nothing to re-key. Indexed anyway, the combinator Redmine nests in one
  # (`span.icon-checked:has(:not(a svg.icon-svg))`) made the whole index unsafe — every child-list change a full re-key.
  it 'leaves a :has() argument out of the index, and the :has() still restyles' do
    got = colors('.c:has(a b) .t { color: rgb(0, 128, 0) } li:first-child span { color: rgb(0, 0, 255) }',
                 '<div class="c"><p class="t" id="t">t</p><a id="a"></a></div><ul id="u"><li><span id="s">s</span></li></ul>', <<~JS)
      const s = document.getElementById('s'), t = document.getElementById('t');
      const before = [color('t'), color('s')], s0 = __csimCtxEpoch(s);
      document.getElementById('u').appendChild(document.createElement('li'));
      const kept = __csimCtxEpoch(s) === s0;
      document.getElementById('a').appendChild(document.createElement('b'));
      return [before, kept, color('t'), __csimCtxGateActive()];
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 255)'], true, 'rgb(0, 128, 0)', true])
  end
end
