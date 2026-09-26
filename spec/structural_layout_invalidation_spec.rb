# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A mutation that flips a selector match on an element OTHER than the one written — a `:has()` above it, a position
# among siblings, `:empty`, an attribute left of a sibling combinator — moves that element's boxes and, through what
# it declares that inherits, its whole subtree's. The layout gate (cascade.js `layoutAttrEffect` /
# `layoutChildListEffect` / `layoutCharDataEffect`) reads the selectors for it; before it, every shape below kept the
# flipped subtree's layout in BOTH engines while `getComputedStyle` was already right, and the native walk replayed
# the stale subtree.
# Each shape is measured before and after the change, in a 300px-wide box, against headless Chrome (in a 300px iframe,
# the same figures): the height of a `<p>` reading `aa bb cc` in 16px monospace at 60px wide is 44 wrapped and 22
# under `white-space: pre`.
RSpec.describe 'layout invalidation through structural selectors' do
  paragraph = '<p id="t" style="margin:0">aa bb cc</p>'
  shapes = [
    # name, css, body, change, [width, height] before, after
    ['a :has() above the writer', '.c:has(.flag) p { white-space: pre }',
     '<div class="c" style="width:60px"><p id="t" style="margin:0">aa bb cc</p><span id="o">o</span></div>',
     "document.getElementById('o').classList.add('flag')", [60, 44], [60, 22]],
    ['a :has() subject whose style inherits', '.c:has(.flag) { white-space: pre }',
     '<div class="c" style="width:60px"><p id="t" style="margin:0">aa bb cc</p><span id="o">o</span></div>',
     "document.getElementById('o').classList.add('flag')", [60, 44], [60, 22]],
    ['a :has() flipped by an insertion', '.c:has(i) { white-space: pre }',
     '<div class="c" style="width:60px"><p id="t" style="margin:0">aa bb cc</p><span id="o">o</span></div>',
     "document.getElementById('o').appendChild(document.createElement('i'))", [60, 44], [60, 22]],
    ['a sibling-relative :has()', '.a:has(+ .flag) { width: 100px }',
     '<div class="a" id="t" style="height:5px"></div><div id="o">o</div>',
     "document.getElementById('o').classList.add('flag')", [300, 5], [100, 5]],
    ['a :has() left of a sibling combinator', '.c:has(.flag) + .d { width: 100px }',
     '<div class="c"><span id="o">o</span></div><div class="d" id="t" style="height:5px"></div>',
     "document.getElementById('o').classList.add('flag')", [300, 5], [100, 5]],
    ['an ancestor matched by :nth-child()', '#q:nth-child(2) p { white-space: pre }',
     '<div id="box"><div id="q" style="width:60px"><p id="t" style="margin:0">aa bb cc</p></div></div>',
     "document.getElementById('box').prepend(document.createElement('i'))", [60, 44], [60, 22]],
    ['a subject matched by :nth-child()', '#box > div:nth-child(2) { width: 100px }',
     '<div id="box"><div id="t" style="height:5px"></div></div>',
     "document.getElementById('box').prepend(document.createElement('div'))", [300, 5], [100, 5]],
    ['a subject that stops being :last-child', '#box > div:last-child { width: 100px }',
     '<div id="box"><div id="t" style="height:5px"></div></div>',
     "document.getElementById('box').append(document.createElement('div'))", [100, 5], [300, 5]],
    ['an ancestor a sibling combinator reaches', '#box > .x + div p { white-space: pre }',
     '<div id="box"><div id="q" style="width:60px"><p id="t" style="margin:0">aa bb cc</p></div></div>',
     "const x = document.createElement('i'); x.className = 'x'; document.getElementById('box').prepend(x)", [60, 44], [60, 22]],
    ['a positional subject whose style inherits', '#box > div:nth-child(2) { white-space: pre }',
     '<div id="box" style="width:60px"><div><p id="t" style="margin:0">aa bb cc</p></div></div>',
     "document.getElementById('box').prepend(document.createElement('i'))", [60, 44], [60, 22]],
    ['the old :first-child, whose style inherited', '#box > div:first-child { white-space: pre }',
     '<div id="box" style="width:60px"><div><p id="t" style="margin:0">aa bb cc</p></div></div>',
     "document.getElementById('box').prepend(document.createElement('i'))", [60, 22], [60, 44]],
    ['an :empty sibling emptied', '.e:empty + div p { white-space: pre }',
     '<span class="e" id="o">x</span><div style="width:60px"><p id="t" style="margin:0">aa bb cc</p></div>',
     "document.getElementById('o').textContent = ''", [60, 44], [60, 22]],
    # …and filled again through a TEXT edit, which flips `:empty` only on the way into or out of the empty string.
    ['an :empty sibling filled by a text edit', '.e:empty + div p { white-space: pre }',
     '<span class="e" id="o"></span><div style="width:60px"><p id="t" style="margin:0">aa bb cc</p></div>',
     "const o = document.getElementById('o'); o.appendChild(document.createTextNode('')); o.offsetHeight; o.firstChild.data = 'x'",
     [60, 22], [60, 44]],
    ['an attribute left of a sibling combinator', '.a[data-x] ~ div p { white-space: pre }',
     '<span class="a" id="o"></span><div style="width:60px"><p id="t" style="margin:0">aa bb cc</p></div>',
     "document.getElementById('o').setAttribute('data-x', '1')", [60, 44], [60, 22]],
    # …a position or `:empty` nested in `:not()`, a `:has()` nested in one, a `:has()` whose argument reads `:empty`,
    # a position, an attribute behind a pseudo-class or a sibling, a token of `:nth-child(… of S)`, an attribute value
    # HTML matches case-insensitively, and a sibling combinator with no token left of it:
    ['a position nested in :not()', '.g > .b:not(:first-child) p { white-space: pre }',
     '<div id="g" class="g" style="width:60px"><div class="b">P</div></div>',
     "document.getElementById('g').prepend(document.createElement('div'))", [60, 44], [60, 22]],
    ['an :empty nested in :not()', '.e:not(:empty) + div p { white-space: pre }',
     '<span class="e" id="o">x</span><div style="width:60px">P</div>',
     "document.getElementById('o').textContent = ''", [60, 22], [60, 44]],
    ['a :has() nested in :not()', '.c:not(:has(.flag)) p { white-space: pre }',
     '<div class="c" style="width:60px">P<span id="o">o</span></div>',
     "document.getElementById('o').classList.add('flag')", [60, 22], [60, 44]],
    ['a :has() reading :empty', '.c:has(.x:empty) p { white-space: pre }',
     '<div class="c" style="width:60px">P<span class="x" id="o">o</span></div>',
     "document.getElementById('o').firstChild.remove()", [60, 44], [60, 22]],
    ['a :has() reading :disabled', '.c:has(:disabled) p { white-space: pre }',
     '<div class="c" style="width:60px">P<input id="o"></div>',
     "document.getElementById('o').disabled = true", [60, 44], [60, 22]],
    ['a :has() reading a position', '.c:has(.y:first-child) p { white-space: pre }',
     '<div class="c" style="width:60px">P<div id="w"><span class="y">y</span></div></div>',
     "document.getElementById('w').prepend(document.createElement('i'))", [60, 22], [60, 44]],
    ['a sideways :has() flipped by an insertion', '.a:has(+ .b) p { white-space: pre }',
     '<div id="w" style="width:60px"><div class="a">P</div></div>',
     "const b = document.createElement('div'); b.className = 'b'; document.getElementById('w').append(b)", [60, 44], [60, 22]],
    ['a token of :nth-child(… of S)', '#box > div:nth-child(1 of .k) p { white-space: pre }',
     '<div id="box" style="width:60px"><div id="o"></div><div class="k">P</div></div>',
     "document.getElementById('o').className = 'k'", [60, 22], [60, 44]],
    ['an attribute value matched case-insensitively', 'form[method=post] p { white-space: pre }',
     '<form id="o" style="width:60px">P</form>',
     "document.getElementById('o').setAttribute('method', 'POST')", [60, 44], [60, 22]],
    ['a sibling combinator with no token', 'li + li p { white-space: pre }',
     '<ul id="u" style="width:60px;padding:0;list-style:none"><li>P</li></ul>',
     "document.getElementById('u').prepend(document.createElement('li'))", [60, 44], [60, 22]],
    # …a RUN of sibling combinators, which reaches past the next sibling — by a removal, a prepend, `:empty`, a `:has()`
    # and a class write — and a finite `:nth-last-child()` range, whose bound the reach is cut to:
    ['a run of sibling combinators after a removal', '.a + li + li p { white-space: pre }',
     '<ul style="width:60px;padding:0;list-style:none"><li class="a" id="o">a</li><li>b</li><li>P</li></ul>',
     "document.getElementById('o').remove()", [60, 22], [60, 44]],
    ['a position left of a sibling combinator', 'li:first-child + li p { white-space: pre }',
     '<ul id="u" style="width:60px;padding:0;list-style:none"><li>a</li><li>P</li></ul>',
     "document.getElementById('u').prepend(document.createElement('li'))", [60, 22], [60, 44]],
    ['an :empty two siblings back', '.e:empty + li + li p { white-space: pre }',
     '<ul style="width:60px;padding:0;list-style:none"><li class="e" id="o">x</li><li>b</li><li>P</li></ul>',
     "document.getElementById('o').textContent = ''", [60, 44], [60, 22]],
    ['a :has() two siblings back', 'li:has(.f) + li + li p { white-space: pre }',
     '<ul style="width:60px;padding:0;list-style:none"><li><span id="o">s</span></li><li>b</li><li>P</li></ul>',
     "document.getElementById('o').className = 'f'", [60, 44], [60, 22]],
    ['a class two siblings back', '.b + li + li p { white-space: pre }',
     '<ul style="width:60px;padding:0;list-style:none"><li id="o">a</li><li>b</li><li>P</li></ul>',
     "document.getElementById('o').className = 'b'", [60, 44], [60, 22]],
    ['a finite :nth-last-child() range', 'li:nth-last-child(-n+2) p { white-space: pre }',
     '<ul id="u" style="width:60px;padding:0;list-style:none"><li>P</li><li>b</li></ul>',
     "document.getElementById('u').append(document.createElement('li'))", [60, 22], [60, 44]],
    # …whose bound does not hold `of S`, which counts S's matches only;
    ['a :nth-child(… of S) range', '#u > li:nth-child(-n+2 of .k) p { white-space: pre }',
     '<ul id="u" style="width:60px;padding:0;list-style:none"><li>a</li><li class="k">b</li><li class="k">P</li></ul>',
     "const k = document.createElement('li'); k.className = 'k'; document.getElementById('u').prepend(k)", [60, 22], [60, 44]],
    # …a `:has()` answer kept across a flip of the REST of its compound (a class on the anchor), then flipped back by a
    # tracked change — only the argument is kept, so the flip back is seen;
    ['a :has() flipped back after its anchor changed', '.c.on:has(.f) p { white-space: pre }',
     '<div id="c" class="c" style="width:60px">P<span id="box"></span></div>',
     "const b = document.getElementById('box'), f = document.createElement('i'); f.className = 'f'; b.append(f); " \
     "document.body.offsetHeight; document.getElementById('c').classList.add('on'); document.body.offsetHeight; b.replaceChildren()",
     [60, 44], [60, 44]],
    # …and pseudo-classes that read an attribute of the element itself.
    ['a pseudo-class reading its own attribute', 'input:required + div p { white-space: pre }',
     '<input id="o"><div style="width:60px">P</div>', "document.getElementById('o').required = true", [60, 44], [60, 22]],
    ['a :has() over [open]', '.c:has(details[open]) p { white-space: pre }',
     '<div class="c" style="width:60px">P<details id="o"><summary>s</summary></details></div>',
     "document.getElementById('o').open = true", [60, 44], [60, 22]]
  ].map {|name, css, body, *rest| [name, css, body.sub('>P<', ">#{paragraph}<"), *rest] }

  def rect(session)
    session.evaluate_script("(() => { const e = document.getElementById('t').getBoundingClientRect(); " \
                            'return [Math.round(e.width * 10) / 10, Math.round(e.height * 10) / 10]; })()')
  end

  def measure(css, body, change, native:)
    html = "<!DOCTYPE html><style>body { margin: 0; font: 16px monospace } #{css}</style><div style=\"width:300px\">#{body}</div>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    # …the native pass authoritative, and every reusing pass walked again fresh and compared (it throws on a difference).
    s.execute_script('globalThis.__csimNativeLayout = true; globalThis.__csimNativeLayoutVerifyReuse = true') if native
    before = rect(s)
    s.execute_script(change)
    [before, rect(s)]
  end

  shapes.each do |name, css, body, change, before, after|
    it "relays out #{name}" do
      expect(measure(css, body, change, native: false)).to eq([before, after])
      expect(measure(css, body, change, native: true)).to eq([before, after])
    end
  end

  # A COUNT, not a wall: what a change reaches is decided from the CHANGE POINT, so appending a row reaches at most the
  # row before it (`:last-child`), never the rows already there — under `tr:nth-child(odd) td` the whole table was relaid
  # out per appended row (6.6x on 600 rows), under `* + *` every sibling, and a `:has()` with a combinator in its
  # argument turned it on for every rule. A class left of a sibling combinator reaches that sibling, not its parent's
  # subtree (21x on 200 toggles beside a 500-row table).
  it 'reaches no more than the change point on an append or a sibling toggle' do
    marks = lambda do |css|
      html = "<!DOCTYPE html><style>#{css}</style><div><p class=t id=t>t</p><p class=small>s</p>" \
             '<table><tbody id=tb></tbody></table><p id=foot>f</p></div>'
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      s.visit '/'
      s.evaluate_script(<<~JS)
        (() => {
          const tb = document.getElementById('tb'), foot = document.getElementById('foot');
          const row = () => { const tr = document.createElement('tr'); tr.innerHTML = '<td>r</td><td>c <b>x</b></td>'; tb.appendChild(tr); foot.getBoundingClientRect(); };
          for (let i = 0; i < 5; i++) row();
          const m0 = __csimSubtreeMarks();
          for (let i = 0; i < 20; i++) row();
          const m1 = __csimSubtreeMarks();
          for (let i = 0; i < 20; i++) { document.getElementById('t').classList.toggle('on'); foot.getBoundingClientRect(); }
          return [(m1 - m0) / 20, (__csimSubtreeMarks() - m1) / 20];
        })()
      JS
    end
    base = marks.call('')
    ['tr:nth-child(odd) td { padding: 1px }', 'tr + tr td { padding-top: 1px }', 'tr:last-child td { padding-bottom: 3px }',
     '* + * { margin-top: 0 }', ':last-child { margin-bottom: 0 }', 'tr:not(:first-child) td { border-top: 1px solid }',
     'body:has(> .modal) { overflow: hidden }', 'td:has(> i) { padding: 1px }', '.t.on + .small { margin-left: 5px }',
     # …and the `:has()` shapes whose match never moves here: each is asked again, and only a change marks anything —
     # asked "could it have changed?", every append relaid the tbody, the wrapper, or the whole document out.
     'tr:has(+ tr.sel) td { padding: 1px }', ':is(h1, h2):has(+ p) { margin: 1px }',
     'tbody:has(> tr:only-child) { margin: 1px }', 'div:has(> b) { padding: 1px }', ':has(b) { padding: 1px }',
     # …a finite `:nth-last-child()` range: the row before the change and the one its bound moves past, not every row.
     ['tr:nth-last-child(-n+2) td { padding: 1px }', 2]].each do |css, allowance = 1|
      append, toggle = marks.call(css)
      expect(append).to be <= base[0] + allowance, css
      expect(toggle).to be <= 1, css
    end
  end

  # …a `::part()` rule behind a `:has()`: the part is a real box one tree in, under the host the flip restyles; and one
  # `::part()` rule on the page no longer turns every other answer off (it marks the writer's subtree beside them).
  # Chrome: 0, then 40.
  it 'relays out a part behind a :has()' do
    html = '<!DOCTYPE html><body style="margin:0"><style>#w:has(.f) x-a::part(p) { margin-left: 40px }</style>' \
           '<div id="w"><x-a id="h"></x-a><i id="i"></i></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('h').attachShadow({mode: 'open'});
        r.innerHTML = '<p id="p" part="p" style="margin:0">x</p>';
        const x = () => r.getElementById('p').getBoundingClientRect().x, before = x();
        document.getElementById('i').className = 'f';
        return [before, x()];
      })()
    JS
    expect(got).to eq([0, 40])
  end

  # …inside a shadow tree, which the document's rules say nothing about: the tree's own rules answer for its elements.
  it 'relays out a :has() inside a shadow tree' do
    html = '<!DOCTYPE html><body><div id="h"></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const r = document.getElementById('h').attachShadow({mode: 'open'});
        r.innerHTML = '<style>p { margin: 0; font: 16px monospace } .c:has(.flag) p { white-space: pre }</style>' +
                      '<div class="c" style="width:60px"><p id="t">aa bb cc</p><span id="o">o</span></div>';
        const h = () => r.getElementById('t').offsetHeight, before = h();
        r.getElementById('o').classList.add('flag');
        return [before, h()];
      })()
    JS
    expect(got).to eq([44, 22])
  end

  # …and for what the streaming parser adds after a parse-time geometry read: a later `<li>` takes `:last-of-type` from
  # the one laid out, and a later `.flag` flips the `:has()`. (Chrome, the final figures: 0 and 22. At the read itself
  # Chrome does not match `:last-of-type` while the list is still being parsed — a Blink deferral the selector spec does
  # not make; this matches the tree as it stands.)
  it 'relays out what a parse-time read laid out before the parser added more' do
    html = '<!DOCTYPE html><style>body { margin: 0; font: 16px monospace } li:last-of-type { margin-left: 40px } ' \
           '.c:has(.flag) p { white-space: pre }</style><ul style="list-style:none;padding:0"><li id="a">a</li>' \
           '<script>document.getElementById("a").getBoundingClientRect()</script><li>b</li></ul>' \
           '<div class="c" style="width:60px"><p id="t" style="margin:0">aa bb cc</p>' \
           '<script>document.getElementById("t").offsetHeight</script><span class="flag">f</span></div>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script("[document.getElementById('a').getBoundingClientRect().x, document.getElementById('t').offsetHeight]")).to eq([0, 22])
  end

  # A write that arrives while the rule set is still changing — a frame's sheet written with `document.write`, and the
  # cascade not yet rebuilt — is answered once the rules are known, not by the writer's subtree alone.
  it 'answers a write made before the frame\'s new sheet was applied' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body></body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const f = document.createElement('iframe'); document.body.appendChild(f);
        const d = f.contentDocument;
        d.open();
        d.write('<!DOCTYPE html><style>body { margin: 0; font: 16px monospace } .c:has(.flag) p { white-space: pre }</style>' +
                '<div class="c" style="width:60px"><p id="t" style="margin:0">aa bb cc</p><span id="o">o</span></div>');
        d.close();
        const h = () => d.getElementById('t').getBoundingClientRect().height, before = h();
        d.getElementById('o').classList.add('flag');
        return [before, h()];
      })()
    JS
    expect(got).to eq([44, 22])
  end
end
