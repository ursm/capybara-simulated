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
end
