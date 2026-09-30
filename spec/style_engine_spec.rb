# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The style engine (stylo over the arena) restyles only what a change reached — the snapshots and hints its change
# hooks leave, the selector flags matching left on a parent, the elements whose state moved. Each example makes one
# kind of change and reads a value it moved; CSIM_STYLE_VERIFY holds every such restyle against styling the whole
# document again, and a read throws when the two differ.
RSpec.describe 'style engine invalidation' do
  around do |example|
    saved = ENV.values_at('CSIM_STYLO', 'CSIM_STYLE_VERIFY')
    ENV['CSIM_STYLO'] = '1'
    ENV['CSIM_STYLE_VERIFY'] = '1'
    example.run
  ensure
    ENV['CSIM_STYLO'], ENV['CSIM_STYLE_VERIFY'] = saved
  end

  CSS = <<~CSS
    div:has(> input:checked) { color: rgb(40, 41, 42); }
    li:nth-child(2 of .x) { color: rgb(43, 44, 45); }
    .on .kid { color: rgb(1, 2, 3); }
    #target { color: rgb(4, 5, 6); }
    li:nth-child(2) { color: rgb(7, 8, 9); }
    .a + .b { color: rgb(10, 11, 12); }
    p:empty { color: rgb(13, 14, 15); }
    input:checked + span { color: rgb(16, 17, 18); }
    x-el:state(big) { color: rgb(19, 20, 21); }
    x-el:state(big) + span { color: rgb(22, 23, 24); }
    .moved { color: rgb(25, 26, 27); }
    #box .moved { color: rgb(28, 29, 30); }
    li:first-child { font-style: italic; }
  CSS

  def visit(body, head: '', assets: {}, css: CSS)
    html = "<!DOCTYPE html><html><head>#{head}<style>#{css}</style></head><body>#{body}</body></html>"
    app = lambda {|env|
      css = assets[env['PATH_INFO']]
      css ? [200, {'content-type' => 'text/css'}, [css]] : [200, {'content-type' => 'text/html'}, [html]]
    }
    session = simulated_session(app)
    session.visit '/'
    session
  end

  def color(session, selector, script = nil)
    session.evaluate_script(<<~JS)
      (() => {
        getComputedStyle(document.body).color;
        #{script}
        return getComputedStyle(document.querySelector(#{selector.to_json})).color;
      })()
    JS
  end

  it 'restyles the descendants a class on an ancestor reaches' do
    s = visit('<div id="p"><span class="kid">k</span></div>')
    expect(color(s, '.kid', 'document.getElementById("p").className = "on";')).to eq('rgb(1, 2, 3)')
  end

  # What is SHOWN is the engine's to say (`__dom.styleShown`): a `display: none` anywhere up the flat tree, the element's
  # own `visibility`, and the UA's rules with them — a popover not showing is `display: none` (HTML §15.3.1), unless an
  # author rule displays it, and so is an SVG `clipPath` (SVG 2 Appendix A's `!important` rule). Chrome and Firefox:
  # false / false / true / false / true, then true / true — and both report the `clipPath` `inline` and visible, which
  # the appendix does not. (The JS cascade has no popover rule: recorded.)
  it 'answers what is shown off the engine' do
    s = visit('<div style="display:none"><p id="a">a</p></div><p id="b" style="visibility:hidden">b</p><p id="c">c</p>' \
              '<div id="pop" popover>p</div><div id="shown" popover style="display:block">s</div><svg><clipPath id="cp"/></svg>',
              css: '')
    got = s.evaluate_script("['a', 'b', 'c', 'pop', 'shown', 'cp'].map((id) => document.getElementById(id).checkVisibility({visibilityProperty: true}))")
    expect(got).to eq([false, false, true, false, true, false])
    s.execute_script("document.getElementById('pop').showPopover(); document.querySelector('div').style.display = 'block'")
    expect(s.evaluate_script("['a', 'pop'].map((id) => document.getElementById(id).checkVisibility({visibilityProperty: true}))")).to eq([true, true])
  end

  # …and whatever moves it: a state the element's OWN restyle does not reach — `:checked ~ .panel` restyles the sibling —
  # flipped there and BACK (the engine held the state against the one it had styled, and never updated it: the second
  # click read as no change), and a hover left; and an ancestor's `content-visibility: hidden` (`hidden=until-found`'s,
  # in the UA sheet) skips what is under it, though it is shown itself. Chrome and Firefox: true, false, true; false,
  # then true; true, false, true, false.
  it 'answers what is shown after a state flips back, and under skipped contents' do
    s = visit('<input type="checkbox" id="cb"><div class="panel" id="p">P</div>',
              css: '.panel { display: none } #cb:checked ~ .panel { display: block }')
    got = Array.new(3) do
      s.find('#cb').click
      s.evaluate_script("document.getElementById('p').checkVisibility()")
    end
    expect(got).to eq([true, false, true])

    s = visit('<div id="hov">h</div><div id="victim">v</div><div id="other">o</div>', css: '#hov:hover + #victim { display: none }')
    s.find('#hov').hover
    expect(s.evaluate_script("document.getElementById('victim').checkVisibility()")).to be(false)
    s.find('#other').hover
    expect(s.evaluate_script("document.getElementById('victim').checkVisibility()")).to be(true)

    s = visit('<div id="uf" hidden="until-found"><p id="ufp">x</p></div><div id="cv" style="content-visibility:hidden"><p id="cvp">y</p></div>',
              css: '')
    expect(s.evaluate_script("['uf', 'ufp', 'cv', 'cvp'].map((id) => document.getElementById(id).checkVisibility())")).to eq([true, false, true, false])

    # …only where the ancestor's box can take size containment, which is what `content-visibility` applies to (CSS
    # Contain 2 §3.1): a non-atomic inline, a table row, group or cell, a box-less `display: contents`, a `ruby` and its
    # internal boxes skip nothing; an inline-block does. Firefox: true × 4, false, true × 3 (Chrome skips under the cell).
    s = visit('<p><span class="h"><b id="spb">b</b></span></p><table><tbody class="h"><tr class="h"><td class="h"><i id="tdi">i</i></td></tr></tbody></table>' \
              '<div class="h" style="display:contents"><div id="dc">d</div></div><div class="h" style="display:table"><div id="tb">t</div></div>' \
              '<span class="h" style="display:inline-block"><b id="ibb">b</b></span>' \
              '<ruby class="h"><i id="rc">r</i><rt class="h"><i id="rti">t</i></rt></ruby><span class="h" style="display:ruby-base"><i id="rbi">b</i></span>',
              css: '.h { content-visibility: hidden }')
    got = s.evaluate_script("['spb', 'tdi', 'dc', 'tb', 'ibb', 'rc', 'rti', 'rbi'].map((id) => document.getElementById(id).checkVisibility())")
    expect(got).to eq([true, true, true, true, false, true, true, true])
  end

  # The JS cascade's rules, built when this side first reads them, follow the sheets through every edit: a `<style>`
  # edited, read, edited to something else and back. The JS walk reads them (`withJsCascade`): one box fewer while `.c`
  # is hidden, as many as the final text's once it is back. (The stale-key half of `ensureJsCascade` — rules built from a
  # text the owing rebuild did not key — needs a reader that does not freshen the cascade first, and no page script
  # reaches one any more: the closed-`<details>` check was the last, and this example guarded it through that.)
  it 'keeps the JS rules in step with the sheets they are built from' do
    boxes = 'globalThis.__csimLayoutShadowRun().nodes'
    body = '<div class="c" id="c">c</div><p class="q" id="q">q</p>'
    s = visit(body, css: '.q { color: red }')
    got = s.evaluate_script(<<~JS)
      (() => {
        const st = document.querySelector('style'), q = document.getElementById('q');
        st.textContent = '.q { color: blue }';
        getComputedStyle(q).color;
        st.textContent = '.c { display: none }';
        const hidden = #{boxes};
        st.textContent = '.q { color: blue }';
        return [hidden, #{boxes}];
      })()
    JS
    expect(got).to eq([2, 3])
  end

  # A page's text, its geometry and its generated content are the engine's to answer, and none of them builds the JS
  # cascade's rules: a `display: none` / `visibility: hidden` / `text-transform` / `white-space` / flex container read for
  # the visible text, the `::before` / `::after` a box lays out, a table's anonymous cell, a `border` shorthand under a
  # border width, and a `<br>` a flex container holds, which still breaks its line. Chrome: the text below (as Capybara
  # normalises its `innerText`), 30.23 × 18, `"B"`, 3px, 36 and 31.
  it 'answers text, geometry and generated content without the JS cascade' do
    s = visit(<<~HTML, css: <<~CSS)
      <div class="flex"><span>one</span><span>two</span></div>
      <p class="up">up <span class="hide">gone</span><span class="vis">vis</span></p>
      <p class="pre">a  b</p>
      <p><span id="g" class="gen" data-x="A" style="display:inline-block">g</span></p>
      <div id="fb" style="display:flex">a<br>b</div>
      <div id="t" style="display:table">stray</div>
      <div id="bd" class="bd">b</div>
    HTML
      .hide { display: none } .vis { visibility: hidden } .up { text-transform: uppercase } .pre { white-space: pre }
      .flex { display: flex } .gen::before { content: "B" } .gen::after { content: attr(data-x) } .bd { border: 3px solid }
    CSS
    expect(s.text).to eq("one\ntwo\nUP\na b\ng\na\nb\nstray\nb")
    got = s.evaluate_script(<<~JS)
      [
        (r => [r.width, r.height])(document.getElementById('g').getBoundingClientRect()),
        getComputedStyle(document.getElementById('g'), '::before').content,
        getComputedStyle(document.getElementById('bd')).borderTopWidth,
        document.getElementById('fb').offsetHeight,
        document.getElementById('t').offsetWidth
      ]
    JS
    (width, height), *rest = got
    expect(width).to be_within(0.02).of(30.23)
    expect([height, *rest]).to eq([18, '"B"', '3px', 36, 31])
    expect(s.evaluate_script('__csimJsCascadeDemands().builds')).to eq(0)
  end

  # …and a box that skips its contents renders no text of them, nor the breaks around it — `hidden=until-found` and an
  # author `content-visibility: hidden` alike — and a shadow host asks the JS rules nothing either. Chrome: "A||", "C||".
  it 'reads no text from skipped contents, and no JS rules for a shadow host' do
    s = visit('<div id="a">A|<div hidden="until-found">uf <b>bb</b></div>|</div><div id="c">C|<div style="content-visibility:hidden">cv</div>|</div>' \
              '<div id="h"></div>', css: '')
    s.execute_script("const h = document.getElementById('h'); h.attachShadow({mode: 'open'}).innerHTML = '<pre><slot></slot></pre>'; h.append('x')")
    expect(s.evaluate_script("['a', 'c'].map((id) => document.getElementById(id).innerText)")).to eq(['A||', 'C||'])
    expect(s.evaluate_script('__csimJsCascadeDemands().builds')).to eq(0)
  end

  # …nor for the flow a box's sides follow: a `dir` attribute turns `margin-inline-start` to the right edge, and a scroll
  # extent asks which way its content overflows (Mastodon's `scrollHeight` reads built the rule set for it). Chrome:
  # 0px / 10px, and 100.
  it 'answers the flow sides without the JS cascade' do
    s = visit('<div dir="rtl" id="d" style="width:100px;height:50px;overflow:auto"><p id="p" style="margin:0;margin-inline-start:10px;height:100px">x</p></div>',
              css: '')
    got = s.evaluate_script(<<~JS)
      (() => { const p = getComputedStyle(document.getElementById('p')); return [p.marginLeft, p.marginRight, document.getElementById('d').scrollHeight]; })()
    JS
    expect(got).to eq(['0px', '10px', 100])
    expect(s.evaluate_script('__csimJsCascadeDemands().builds')).to eq(0)
  end

  # …nor for an element not in the document, which the engine never styles: its client box, its styles, and an
  # IntersectionObserver still watching it once it left (Avo's pages built the rule set for these). Chrome: 0 and "".
  it 'answers an element out of the document without the JS cascade' do
    s = visit('<div id="a">a</div>', css: 'div { color: red; margin-left: 5px }')
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.createElement('div'), a = document.getElementById('a');
        new IntersectionObserver(() => {}).observe(a);
        a.remove();
        const g = getComputedStyle(d);
        return [d.clientWidth, g.display, g.color, g.marginLeft];
      })()
    JS
    expect(got).to eq([0, '', '', ''])
    s.evaluate_script('new Promise((resolve) => requestAnimationFrame(() => resolve(true)))')
    expect(s.evaluate_script('__csimJsCascadeDemands().builds')).to eq(0)
  end

  # A paint recording lays the page out with the JS walk, after a pass the Rust walk wrote — and a box's edges from THAT
  # pass are not this one's: a container's `margin-left` written in between left its text drawn where it had been
  # (the WPT reftest `offset-change-inline-backface-visibility-hidden`), its background where it went. The glyph's ink
  # starts at x 100, as its box does.
  it 'paints text where a margin written after the last pass put it' do
    require 'vips'
    s = visit('<div id="c"><div style="width: 100px; font: 30px monospace"><span>X</span></div></div>', css: 'body { margin: 0 }')
    s.evaluate_script('document.body.offsetHeight')   # the Rust walk's pass, before the write
    s.execute_script("document.getElementById('c').style.marginLeft = '100px'")
    path = File.join(Dir.tmpdir, "csim-edges-#{Process.pid}.png")
    s.driver.save_screenshot(path)
    img = Vips::Image.new_from_file(path)
    raw = img.write_to_memory
    ink = (0...img.width).select {|x| (0...30).any? {|y| raw.byteslice(((y * img.width) + x) * img.bands, 3).bytes[0] < 128 } }
    expect(ink.min).to be >= 100
  ensure
    File.delete(path) if path && File.exist?(path)
  end

  # An element under a `display: none` — styled by no traversal — is resolved on its own, its unstyled ancestors with it
  # (Gecko's `ResolveStyleLazily`): its colour, its em-relative lengths and its percentages as Chrome reports them
  # (rgb(1, 2, 3), 0px, 30px, auto, 10px, block; then 50% and none), where it was answered by the JS cascade.
  it 'resolves the style of an element no traversal styled' do
    s = visit('<div class="d" style="display:none"><p id="p">x</p></div><div id="x" style="display:none;width:50%"></div>',
              css: '.d { color: rgb(1, 2, 3); padding: 2em; font-size: 10px } .d p { margin-left: 3em }')
    got = s.evaluate_script(<<~JS)
      ['p', 'x'].map((id) => { const g = getComputedStyle(document.getElementById(id)); return [g.color, g.paddingLeft, g.marginLeft, g.width, g.fontSize, g.display]; })
    JS
    expect(got).to eq([['rgb(1, 2, 3)', '0px', '30px', 'auto', '10px', 'block'], ['rgb(0, 0, 0)', '0px', '0px', '50%', '16px', 'none']])
  end

  it 'restyles an element whose id changed' do
    s = visit('<div id="x">x</div>')
    expect(color(s, 'div', 'document.getElementById("x").id = "target";')).to eq('rgb(4, 5, 6)')
  end

  it 'restyles the siblings a structural pseudo-class reaches when a child is inserted' do
    s = visit('<ul><li id="one">1</li><li id="two">2</li></ul>')
    script = 'document.querySelector("ul").prepend(document.createElement("li"));'
    expect(color(s, '#one', script)).to eq('rgb(7, 8, 9)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("two")).color')).to eq('rgb(0, 0, 0)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("one")).fontStyle')).to eq('normal')
  end

  it 'restyles the element a sibling combinator reaches when its sibling changes' do
    s = visit('<i id="first">1</i><i id="second" class="b">2</i>')
    expect(color(s, '#second', 'document.getElementById("first").className = "a";')).to eq('rgb(10, 11, 12)')
  end

  # A text node with no data is no content (Selectors' `:empty`, and Chrome): emptying it empties the parent.
  it 'restyles a parent whose emptiness changed with its text' do
    s = visit('<p id="p">text</p>')
    expect(color(s, '#p', 'document.getElementById("p").firstChild.data = "";')).to eq('rgb(13, 14, 15)')
    expect(color(s, '#p', 'document.getElementById("p").append("more");')).to eq('rgb(0, 0, 0)')
  end

  # …and a `:has()` that asks it — the one way a text edit reaches beyond its parent. An edit that leaves some text
  # there changes nothing a selector sees, and restyles nothing (a `:has()` rule anywhere used to restyle the whole page
  # on every keystroke).
  it 'restyles through a :has() when a text edit empties an element, and not otherwise' do
    s = visit('<div id="d"><p id="p">text</p></div>', css: '#d:has(p:empty) { color: rgb(61, 62, 63); }')
    expect(color(s, '#d', 'document.getElementById("p").firstChild.data = "more text";')).to eq('rgb(0, 0, 0)')
    expect(color(s, '#d', 'document.getElementById("p").firstChild.data = "";')).to eq('rgb(61, 62, 63)')
    expect(color(s, '#d', 'document.getElementById("p").firstChild.appendData("x");')).to eq('rgb(0, 0, 0)')
  end

  # …and an attribute a `:has()` names, written on an element nothing styles (under a `display: none`): it still
  # decides the match above it, so it restyles — where an attribute no argument names does not have to.
  it 'restyles through a :has() when an unstyled element gains a class or an attribute it names' do
    s = visit('<div id="d"><div style="display: none"><i id="i"></i></div></div>',
              css: '#d:has(.flag) { color: rgb(64, 65, 66); } #d:has([data-x]) { background-color: rgb(1, 1, 1); }')
    expect(color(s, '#d', 'document.getElementById("i").className = "flag";')).to eq('rgb(64, 65, 66)')
    expect(color(s, '#d', 'document.getElementById("i").setAttribute("data-k", "1");')).to eq('rgb(64, 65, 66)')
    expect(color(s, '#d', 'document.getElementById("i").className = "";')).to eq('rgb(0, 0, 0)')
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('i').setAttribute('data-x', '');
        return getComputedStyle(document.getElementById('d')).backgroundColor;
      })()
    JS
    expect(got).to eq('rgb(1, 1, 1)')
  end

  # …and an attribute that moves a STATE a `:has()` reads (`disabled` → `:disabled`), and a namespaced attribute by its
  # local name (`xlink:href` → `[xlink|href]`), on such an element.
  it 'restyles through a :has() when an unstyled element gains a state or a namespaced attribute it reads' do
    s = visit('<div id="d"><div style="display: none"><button id="b">b</button><svg><a id="a"></a></svg></div></div>',
              css: '@namespace xl url(http://www.w3.org/1999/xlink); #d:has(:disabled) { color: rgb(67, 68, 69); } ' \
                   '#d:has([xl|href]) { background-color: rgb(2, 2, 2); }')
    expect(color(s, '#d', 'document.getElementById("b").setAttribute("disabled", "");')).to eq('rgb(67, 68, 69)')
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('a').setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#x');
        return getComputedStyle(document.getElementById('d')).backgroundColor;
      })()
    JS
    expect(got).to eq('rgb(2, 2, 2)')
  end

  # …and so is every sibling a combinator reads it from (Firefox's `RestyleForEmptyChange`). (On a page of its own: a
  # `:has()` anywhere styles everything again after any change.)
  it 'restyles the later siblings an emptiness reaches through a sibling combinator' do
    s = visit('<div><span class="e" id="e">text</span><i class="t" id="t">t</i></div>', css: '.e:empty + .t { color: rgb(49, 50, 51); }')
    expect(color(s, '#t', 'document.getElementById("e").firstChild.data = "";')).to eq('rgb(49, 50, 51)')
  end

  # …a shadow tree's top level included, whose parent is the shadow root.
  it "restyles the later siblings an emptiness reaches at a shadow tree's top level" do
    s = visit('<div id="h"></div>', css: '')
    read = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('h').attachShadow({mode: 'open'});
        sr.innerHTML = '<style>.e:empty + .t { color: rgb(49, 50, 51) }</style><span class="e">x</span><i class="t">t</i>';
        getComputedStyle(sr.querySelector('.t')).color;
        sr.querySelector('.e').firstChild.data = '';
        return getComputedStyle(sr.querySelector('.t')).color;
      })()
    JS
    expect(read).to eq('rgb(49, 50, 51)')
  end

  # A `<style>` rewritten after the page was styled: the engine is asked with the text it has now.
  it 'styles with the text a style element has now' do
    s = visit('<p id="p">p</p>', head: '<style id="st"></style>')
    expect(color(s, '#p', 'document.getElementById("st").textContent = "#p { color: rgb(3, 3, 3) }";')).to eq('rgb(3, 3, 3)')
  end

  it 'restyles what an element state reaches' do
    s = visit('<input type="checkbox" id="c"><span id="s">s</span>')
    expect(color(s, '#s', 'document.getElementById("c").checked = true;')).to eq('rgb(16, 17, 18)')
  end

  it 'restyles a style attribute' do
    s = visit('<div id="d">d</div>')
    expect(color(s, '#d', 'document.getElementById("d").style.color = "rgb(31, 32, 33)";')).to eq('rgb(31, 32, 33)')
  end

  it 'restyles a presentational hint' do
    s = visit('<font id="f">f</font>')
    expect(color(s, '#f', 'document.getElementById("f").setAttribute("color", "#ff0000");')).to eq('rgb(255, 0, 0)')
  end

  it 'restyles what a custom state reaches' do
    s = visit('<x-el id="x">x</x-el><span id="after">a</span>')
    script = <<~JS
      customElements.define('x-el', class extends HTMLElement {
        constructor() { super(); this.i = this.attachInternals(); }
      });
      getComputedStyle(document.getElementById('x')).color;
      document.getElementById('x').i.states.add('big');
    JS
    expect(color(s, '#x', script)).to eq('rgb(19, 20, 21)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("after")).color')).to eq('rgb(22, 23, 24)')
  end

  it 'restyles an element moved to where other rules match it' do
    s = visit('<div id="box"></div><span class="moved" id="m">m</span>')
    expect(color(s, '#m', 'document.getElementById("box").append(document.getElementById("m"));')).to eq('rgb(28, 29, 30)')
  end

  it 'restyles a node taken out and put back where other rules match it' do
    s = visit('<div id="box"></div><span class="moved" id="m">m</span>')
    script = 'const m = document.getElementById("m"); m.remove(); document.getElementById("box").append(m);'
    expect(color(s, '#m', script)).to eq('rgb(28, 29, 30)')
  end

  it 'restyles what a `:has()` reaches when a state inside it changes' do
    s = visit('<div id="d"><input type="checkbox" id="c"></div>')
    expect(color(s, '#d', 'document.getElementById("c").checked = true;')).to eq('rgb(40, 41, 42)')
  end

  it 'restyles the siblings an `:nth-child(… of S)` counts when one starts matching S' do
    s = visit('<ul><li id="a" class="x">a</li><li id="b">b</li><li id="c" class="x">c</li></ul>')
    expect(color(s, '#c', 'document.getElementById("b").className = "x";')).to eq('rgb(0, 0, 0)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("b")).color')).to eq('rgb(43, 44, 45)')
  end

  # (The padding itself is layout's to report; any read after the change runs the verify pass, which compares it.)
  # A `:has()` whose argument is a TYPE alone is noted in the engine's additional relative-selector map, which is what
  # says to restyle on an insertion anywhere under it.
  it 'restyles what a :has() of a type reaches when one is inserted under it' do
    s = visit('<div class="h"><p id="t">t</p><span id="o">o</span></div>', css: '.h:has(i) p { color: rgb(46, 47, 48) }')
    expect(color(s, '#t', 'document.getElementById("o").appendChild(document.createElement("i"));')).to eq('rgb(46, 47, 48)')
  end

  it "restyles a table's cells when its cellpadding changes" do
    s = visit('<table id="t" cellpadding="3"><tr><td id="c">c</td></tr></table>')
    expect(color(s, '#c', 'document.getElementById("t").setAttribute("cellpadding", "9");')).to eq('rgb(0, 0, 0)')
  end

  # A bordered table frames its cells only while its border is not zero (`:-servo-nonzero-border`): writing the border
  # restyles them, through the table's state.
  it "restyles a table's cells when its border changes" do
    s = visit('<table id="t" border="2"><tbody><tr><td id="c">c</td></tr></tbody></table>')
    %w[0 1].each do |border|
      expect(color(s, '#c', %(document.getElementById("t").setAttribute("border", "#{border}");))).to eq('rgb(0, 0, 0)')
    end
    expect(color(s, '#c', 'document.getElementById("t").removeAttribute("border");')).to eq('rgb(0, 0, 0)')
  end

  it "restyles a shadow tree's top-level children when one is inserted before them" do
    s = visit('<div id="h"></div>')
    first = s.evaluate_script(<<~JS)
      (() => {
        const sr = document.getElementById('h').attachShadow({mode: 'open'});
        sr.innerHTML = '<style>span:first-of-type { color: rgb(46, 47, 48) }</style><span id="s">s</span>';
        getComputedStyle(sr.getElementById('s')).color;
        sr.prepend(document.createElement('span'));
        return getComputedStyle(sr.getElementById('s')).color;
      })()
    JS
    expect(first).to eq('rgb(0, 0, 0)')
  end

  it 'keeps styling after the document URL changes (one lock for the realm)' do
    s = visit('<div id="d" style="color: rgb(1, 2, 3)">d</div>')
    script = <<~JS
      history.pushState({}, '', '/other/path/x');
      const st = document.createElement('style'); st.textContent = 'p {}'; document.head.append(st);
    JS
    expect(color(s, '#d', script)).to eq('rgb(1, 2, 3)')
  end

  it 'answers the media queries of the viewport it has now' do
    s = visit('<p id="p">p</p>', head: '<style>@media (max-width: 500px) { p { color: rgb(1, 1, 1) } }</style>')
    expect(color(s, '#p')).to eq('rgb(0, 0, 0)')
    s.current_window.resize_to(400, 600)
    expect(color(s, '#p')).to eq('rgb(1, 1, 1)')
  end

  # An id is a state input: `:target` names one, and `<input form=…>` finds its form owner by one. (These three hold
  # the behaviour; on this path the JS side's own writes moved the state epoch too, so they passed before the fix.)
  it 'restyles the target when an id makes it one' do
    s = visit('<div id="d">d</div>', head: '<style>:target { color: rgb(2, 2, 2) }</style>')
    expect(color(s, 'div', 'location.hash = "#x"; getComputedStyle(document.getElementById("d")).color; document.getElementById("d").id = "x";')).to eq('rgb(2, 2, 2)')
  end

  it 'restyles the forms whose controls an id change moves' do
    s = visit('<form id="f"></form><form id="g"></form><input form="f" required>',
              head: '<style>form:invalid { color: rgb(4, 5, 6) }</style>')
    script = 'const f = document.getElementById("f"), g = document.getElementById("g"); f.id = "z"; g.id = "f";'
    expect(color(s, '#f', script)).to eq('rgb(4, 5, 6)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("z")).color')).to eq('rgb(0, 0, 0)')
  end

  it 'restyles a textarea whose text is its value when the text changes' do
    s = visit('<textarea id="t" required placeholder="p">x</textarea>',
              head: '<style>textarea:invalid { color: rgb(4, 5, 6) }</style>')
    expect(color(s, '#t', 'document.getElementById("t").firstChild.data = "";')).to eq('rgb(4, 5, 6)')
  end

  it 'lets the light children of a host that gains a shadow root go' do
    s = visit('<div id="h" class="h"><span id="s">s</span></div>', head: '<style>.h span { color: rgb(1, 2, 3) }</style>')
    script = <<~JS
      getComputedStyle(document.getElementById('s')).color;
      const sr = document.getElementById('h').attachShadow({mode: 'open'});
      sr.innerHTML = '<b>x</b>';
      document.getElementById('h').className = '';
    JS
    expect(color(s, '#s', script)).to eq('rgb(0, 0, 0)')
  end

  it 'sets no declaration from a font face that is no family list' do
    s = visit('<font id="f" face="x; color: rgb(1, 2, 3)">f</font>')
    expect(color(s, '#f')).to eq('rgb(0, 0, 0)')
  end

  # `<iframe frameborder="0">` (or one no integer: `no`) takes the border's width away, not its inset style (HTML
  # §15.4.3).
  it 'takes the border width, not the style, of an iframe with no frame border' do
    s = visit('<iframe id="f" frameborder="no"></iframe>')
    read = s.evaluate_script('["borderTopWidth", "borderTopStyle"].map((p) => getComputedStyle(document.getElementById("f"))[p]).join(" ")')
    expect(read).to eq('0px inset')
  end

  # A `<select>` is a list box by its `multiple` and its `size` PARSED as a non-negative integer (HTML rendering
  # §15.5.15) — ` 1 ` and junk are drop-downs — which is a state the UA sheet asks, not an attribute string; and a
  # size set later moves it (CSIM_STYLE_VERIFY holds the restyle against a full one).
  it 'styles a list box by its parsed display size' do
    s = visit(%w[1 \ 1\  0 x 2 +3].map {|v| %(<select size="#{v}"></select>) }.join + '<select multiple></select><select multiple size="1"></select><select id="late"></select>')
    read = s.evaluate_script('[...document.querySelectorAll("select")].map((e) => getComputedStyle(e).overflowY).join(" ")')
    expect(read).to eq('clip clip clip clip scroll scroll scroll clip clip')
    expect(s.evaluate_script('(() => { document.getElementById("late").size = 4; return getComputedStyle(document.getElementById("late")).overflowY })()')).to eq('scroll')
  end

  # What a page can write is not what the engine was built for: the keywords and properties a Firefox build of the
  # engine takes, a Servo build takes too — and a flow-relative `resize` computes as specified (css-ui-4, Chrome; a
  # Firefox build makes it physical).
  it 'takes the values a Firefox build of the engine takes' do
    s = visit('<div id="d">d</div>')
    values = {
      'background-attachment' => 'local',
      'background-clip'       => 'text',
      'font-variant-caps'     => 'all-small-caps',
      'pointer-events'        => 'visiblepainted',
      'image-rendering'       => 'smooth',
      'white-space-collapse'  => 'preserve-spaces',
      'column-height'         => '10px',
      'column-wrap'           => 'wrap',
      'resize'                => 'block',
      'text-indent'           => '10px hanging each-line'
    }
    read = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        const values = #{values.to_json};
        for (const [p, v] of Object.entries(values)) d.style.setProperty(p, v);
        return Object.fromEntries(Object.keys(values).map((p) => [p, getComputedStyle(d).getPropertyValue(p)]));
      })()
    JS
    expect(read).to eq(values)
  end

  # `:dir()` is the element's HTML DIRECTIONALITY, a state the engine matches like any other — a `dir=auto` scope's
  # from the first strong character of its text — and HTML's UA sheet sets `direction` from it (`[dir]:dir(rtl)`). So
  # a text edit that flips the scope restyles what matches, and what inherits from it (Chrome: ltr, then rtl).
  it 'matches :dir() by a dir=auto scope and restyles it when its text flips it' do
    s = visit('<div id="d" dir="auto"><p id="p">hello</p></div>', css: 'p:dir(rtl) { color: rgb(1, 2, 3) }')
    got = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p');
        const read = () => [getComputedStyle(p).color, getComputedStyle(document.getElementById('d')).direction, getComputedStyle(p).direction];
        const before = read();
        p.firstChild.data = '\u05e9\u05dc\u05d5\u05dd';
        return before.concat(read());
      })()
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'ltr', 'ltr', 'rgb(1, 2, 3)', 'rtl', 'rtl'])
  end
end

# HTML's directionality steps an element takes by ITSELF, in both engines: a telephone `<input>` with no valid `dir`
# is ltr in an rtl scope (a number reads left to right in any script), and a `<bdi>` whose `dir` is INVALID is auto —
# as one with none (Chrome and Firefox: `ltr` and `rtl`).
RSpec.describe 'directionality' do
  [nil, '1'].each do |stylo|
    it "takes a telephone input's and an invalid-dir bdi's own direction#{stylo ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = '<!DOCTYPE html><div dir="rtl"><input id="t" type="tel"></div><div><bdi id="b" dir="foo">&#x5e9;&#x5dc;</bdi></div>'
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      s.visit '/'
      got = s.evaluate_script("['t', 'b'].map((id) => { const e = document.getElementById(id); return [getComputedStyle(e).direction, e.matches(':dir(rtl)')]; })")
      expect(got).to eq([['ltr', false], ['rtl', true]])
    ensure
      ENV['CSIM_STYLO'] = saved
    end
  end

  # `dir=auto` by the first character of Bidi_Class L, R or AL — an Arabic-Indic digit (AN) and a Hebrew point (NSM)
  # are none, a leading LRM is L, Adlam R — skipping only an HTML element with a valid `dir` of its own (an SVG or MathML
  # `dir` is no such attribute, and sets no directionality); a shadow tree's `<slot>` ends the scan with its host's, a
  # `<slot>` in no shadow tree is scanned like any element, and an unassigned `<slot dir=auto>` reads its fallback.
  # Read through a `:dir()` RULE, so the style engine's own directionality answers in its mode (`matches()` is the JS
  # side's in both). Chrome and Firefox, every row: L L L R L L R R R R.
  [nil, '1'].each do |stylo|
    it "resolves dir=auto by Bidi_Class and HTML's own steps#{stylo ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = '<!DOCTYPE html><meta charset="utf-8"><style>:dir(rtl) { color: rgb(255, 0, 0) } :dir(ltr) { color: rgb(0, 128, 0) }</style>' \
             '<div dir="auto"><span id="a">x</span>&#x5e9;&#x5dc;</div>' \
             '<div dir="auto">&#x663; abc<span id="b">x</span></div>' \
             '<div dir="auto">&#x200e;&#x5e9;&#x5dc;<span id="c">x</span></div>' \
             '<div dir="auto">&#x1e900;<span id="d">x</span></div>' \
             '<div dir="auto">&#x591;abc<span id="e">x</span></div>' \
             '<div dir="auto"><slot><span id="f">x</span>&#x5e9;&#x5dc;</slot></div>' \
             '<div dir="auto"><slot>&#x5e9;&#x5dc;</slot><span id="g">x</span></div>' \
             '<div dir="auto"><svg><text dir="ltr">&#x5e9;&#x5dc;</text></svg><span id="h">x</span></div>' \
             '<div dir="rtl"><svg><g id="i" dir="ltr"></g></svg></div>' \
             '<div id="host"></div>'
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          const sr = document.getElementById('host').attachShadow({mode: 'open'});
          sr.innerHTML = '<style>:dir(rtl) { color: rgb(255, 0, 0) } :dir(ltr) { color: rgb(0, 128, 0) }</style><slot id="j" dir="auto">&#x5e9;&#x5dc;</slot>';
          const at = (e) => (getComputedStyle(e).color === 'rgb(255, 0, 0)' ? 'R' : 'L');
          return ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => at(document.getElementById(id))).concat([at(sr.getElementById('j'))]).join(' ');
        })()
      JS
      expect(got).to eq('L L L R L L R R R R')
    ensure
      ENV['CSIM_STYLO'] = saved
    end
  end
end

# The cascade's own order of sheets, in both engines: a `<style>` written after a `<link>` wins over it.
RSpec.describe 'style sheet order' do
  [nil, '1'].each do |stylo|
    it "cascades <style> and <link> in tree order#{stylo ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = '<!DOCTYPE html><link rel="stylesheet" href="/b.css"><style>.ord { color: rgb(0, 128, 0) }</style><p class="ord" id="p">p</p>'
      app = lambda {|env|
        env['PATH_INFO'] == '/b.css' ? [200, {'content-type' => 'text/css'}, ['.ord { color: rgb(255, 0, 0) }']] : [200, {'content-type' => 'text/html'}, [html]]
      }
      s = simulated_session(app)
      s.visit '/'
      expect(s.evaluate_script('getComputedStyle(document.getElementById("p")).color')).to eq('rgb(0, 128, 0)')
    ensure
      ENV['CSIM_STYLO'] = saved
    end
  end

  # An SVG `STYLE` is no style element (the local name is case-sensitive outside HTML), whatever its lowercase is.
  it 'applies no sheet from an element that is no style element' do
    html = '<!DOCTYPE html><svg id="s"></svg><p id="p">p</p>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    color = s.evaluate_script(<<~JS)
      (() => {
        const st = document.createElementNS('http://www.w3.org/2000/svg', 'STYLE');
        st.textContent = 'p { color: rgb(1, 2, 3) }';
        document.getElementById('s').append(st);
        return getComputedStyle(document.getElementById('p')).color;
      })()
    JS
    expect(color).to eq('rgb(0, 0, 0)')
  end
end
