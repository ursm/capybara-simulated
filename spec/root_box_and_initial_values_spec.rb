require 'capybara/simulated'
require 'rack'

# Two contracts a browser satisfies that page code reads directly, and that we used to get wrong in
# ways that cancelled out only while the page sat unscrolled at the origin:
#
#   * the ROOT element's client rect moves with the document scroll (`html`'s rect is at
#     `(-scrollX, -scrollY)`), and is only as tall as its content — `scrollHeight`, not the rect,
#     is what's floored at the viewport;
#   * `getComputedStyle` reports a property's INITIAL value, not '', for anything no rule sets.
#
# Together they decide whether Floating UI (which positions every dropdown in Discourse, and is used
# by Avo / Forem / countless apps) thinks a reference element is on screen: it derives the left
# scrollbar offset as `getBoundingClientRect(html).left + scrollLeft` — 0 only because the two
# cancel — and treats `transform !== 'none'` as "this ancestor establishes a containing block", so an
# empty string reads as "transformed". Every expectation here is real Chrome's, read off the same
# markup with `--headless --dump-dom` at 1024x768.
RSpec.describe 'root box + computed initial values' do
  def session(body)
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  def tall_page
    <<~HTML
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 }
        #tall { height: 2000px; width: 1600px }
        #below { position: absolute; top: 1500px; left: 0; width: 100px; height: 20px }
      </style></head>
      <body><div id="tall">x</div><div id="below">hit me</div></body></html>
    HTML
  end

  def short_page
    <<~HTML
      <!DOCTYPE html>
      <html><head><style>body { margin: 0 } #s { height: 100px }</style></head>
      <body><div id="s">x</div></body></html>
    HTML
  end

  it 'moves the root element box with the document scroll' do
    s = session(tall_page)
    s.execute_script 'window.scrollTo(300, 500)'
    rect = s.evaluate_script(<<~JS)
      (b => [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)])(
        document.documentElement.getBoundingClientRect())
    JS
    # Chrome: [-300, -500, 1009, 2000] — the width is its clientWidth (viewport minus the scrollbar
    # we don't model), NOT the 1600 scrollWidth, and the height is the content's.
    expect(rect).to eq([-300, -500, 1024, 2000])
  end

  it 'keeps the left scrollbar offset Floating UI derives at zero' do
    s = session(tall_page)
    s.execute_script 'window.scrollTo(300, 500)'
    # `getBoundingClientRect(html).left + scrollLeft` — Floating UI's getWindowScrollBarX. A root
    # box pinned at x=0 made this the whole scroll offset, which then shifted every reference rect
    # left by that much and made on-screen elements look fully clipped.
    expect(s.evaluate_script('document.documentElement.getBoundingClientRect().left + window.scrollX')).to eq(0)
  end

  it 'reports a root rect shorter than the viewport, but never a shorter scrollHeight' do
    s = session(short_page)
    expect(s.evaluate_script('Math.round(document.documentElement.getBoundingClientRect().height)')).to eq(100)
    # Chrome: 681 (768 minus its horizontal scrollbar). Never less than clientHeight — scroll math
    # divides by the difference.
    expect(s.evaluate_script('document.documentElement.scrollHeight')).to eq(768)
    expect(s.evaluate_script('document.documentElement.clientHeight')).to eq(768)
  end

  it 'scrolls a click target into view by the minimum, not to the centre' do
    s = session(tall_page)
    s.find(:css, '#below').click
    # WebDriver's element-click scrolls the target into view the way `scrollIntoView({block:
    # 'nearest', inline: 'nearest'})` does — the minimum on each axis — so the box lands at the
    # BOTTOM of the viewport and the horizontal offset is untouched. Centring instead moved the
    # page sideways on a page whose horizontal overflow was incidental, shifting everything the
    # test looked at next.
    expect(s.evaluate_script('window.scrollX')).to eq(0)
    expect(s.evaluate_script('window.scrollY')).to eq(1520 - 768)
  end

  it 'reports initial values, not empty strings, for properties nothing sets' do
    s = session(short_page)
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('s'));
        const out = {};
        for (const p of ['transform', 'perspective', 'filter', 'willChange', 'contain',
                         'containerType', 'isolation', 'mixBlendMode', 'clipPath', 'zIndex'])
          out[p] = c[p];
        return out;
      })()
    JS
    expect(got).to eq(
      'transform'     => 'none',
      'perspective'   => 'none',
      'filter'        => 'none',
      'willChange'    => 'auto',
      'contain'       => 'none',
      'containerType' => 'normal',
      'isolation'     => 'auto',
      'mixBlendMode'  => 'normal',
      'clipPath'      => 'none',
      'zIndex'        => 'auto'
    )
  end

  it 'reports the computed form where it differs from the specified initial' do
    s = session(short_page)
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('s'));
        return [c.color, c.backgroundColor, c.fontWeight, c.textIndent, c.textAlign];
      })()
    JS
    # `color`'s specified initial is the `canvastext` system colour, `font-weight`'s is `normal`,
    # `text-indent`'s is a unitless `0` — each computes to the form below.
    expect(got).to eq(['rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)', '400', '0px', 'start'])
  end

  it 'expands an overflow shorthand from a stylesheet to both axes' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#clip { overflow: hidden } #two { overflow: hidden auto }</style></head>
      <body><div id="clip">x</div><div id="two">y</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = getComputedStyle(document.getElementById('clip'));
        const b = getComputedStyle(document.getElementById('two'));
        return [a.overflow, a.overflowX, a.overflowY, b.overflowX, b.overflowY];
      })()
    JS
    expect(got).to eq(['hidden', 'hidden', 'hidden', 'hidden', 'auto'])
  end

  it 'leaves a click target that already spans the viewport where it is' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>body { margin: 0 } #huge { height: 3000px }</style></head>
      <body><div id="huge">tall</div></body></html>
    HTML
    s.execute_script 'window.scrollTo(0, 1000)'
    s.find(:css, '#huge').click
    # CSSOM-View's `nearest` does nothing for a box that starts above the viewport and ends below
    # it — it already covers the visible area. Aligning its start instead would jump the page to
    # the top of any element taller than the window, on every click.
    expect(s.evaluate_script('window.scrollY')).to eq(1000)
  end

  it 'resolves an inline shorthand to its longhands in the computed style' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="sh" style="flex: 1; outline: 1px solid red; list-style: square"></div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('sh'));
        return [c.flexGrow, c.flexShrink, c.outlineColor, c.outlineStyle, c.listStyleType];
      })()
    JS
    # The cascade reads the inline attribute through the same expansion the CSSOM side uses, so a
    # shorthand reaches the longhands here exactly as it does through `el.style.flexGrow`.
    expect(got).to eq(['1', '1', 'rgb(255, 0, 0)', 'solid', 'square'])
  end

  it 'reports a stylesheet-declared containing-block property truthfully' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#t { transform: translateX(10px) } #f { filter: blur(2px) }</style></head>
      <body><div id="t">t</div><div id="f">f</div><div id="p">p</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('t').transform, g('f').filter, g('p').transform];
      })()
    JS
    # Reporting the initial for a property a rule actually sets would be the containing-block bug in
    # the opposite direction — Floating UI would then treat a genuinely transformed ancestor as
    # transparent. The cascade captures these, so only the untouched element reports `none`.
    expect(got).to eq(['translateX(10px)', 'blur(2px)', 'none'])
  end

  it 'keeps a case-sensitive custom-property reference through a keyword shorthand' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>:root { --Foo: hidden } #up { overflow: var(--Foo) }</style></head>
      <body><div id="up">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => { const c = getComputedStyle(document.getElementById('up')); return [c.overflowX, c.overflowY]; })()
    JS
    # A keyword property's value folds to lowercase — but not through a function, where the folded
    # text would name a DIFFERENT (case-sensitive) custom property and resolve to nothing.
    expect(got).to eq(['hidden', 'hidden'])
  end

  it 'never reports currentcolor as a resolved value' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#c { color: rgb(0, 128, 0) }</style></head>
      <body><div id="c">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('c'));
        return [c.textDecorationColor, c.columnRuleColor, c.textEmphasisColor];
      })()
    JS
    # `currentcolor` is the INITIAL of most colour longhands and never survives to a computed value:
    # a browser reports the element's own `color`, which is what a colour parser downstream expects.
    expect(got).to eq(['rgb(0, 128, 0)', 'rgb(0, 128, 0)', 'rgb(0, 128, 0)'])
  end

  it 'reports the browser value for the initials mdn-data records wrong' do
    s = session(short_page)
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('s'));
        return [c.floodOpacity, c.stopOpacity, c.shapeImageThreshold, c.textAlign];
      })()
    JS
    # mdn-data says `flood-opacity` / `stop-opacity` are "black" (they are <'opacity'>, initial 1),
    # writes `shape-image-threshold` as "0.0", and `text-align`'s initial in prose. The generator
    # corrects all four rather than shipping them.
    expect(got).to eq(['1', '1', '0', 'start'])
  end

  it 'inherits a value declared by a shadow tree stylesheet' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="host"></div><script>
        const r = document.getElementById('host').attachShadow({mode: 'open'});
        r.innerHTML = '<style>div { color: rgb(255, 0, 0) }</style><div id="a"><span id="b">x</span></div>';
      </script></body></html>
    HTML
    # The inheritance walk skips the per-ancestor cascade lookup when NO rule declares the property
    # — but a shadow tree's own sheet isn't in that document-scope index, so the skip must not apply
    # to an element inside one.
    expect(s.evaluate_script(<<~JS)).to eq('rgb(255, 0, 0)')
      getComputedStyle(document.getElementById('host').shadowRoot.getElementById('b')).color
    JS
  end

  it 'computes color: currentcolor as inherit instead of recursing' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#outer { color: rgb(0, 0, 255) } #c { color: currentcolor }</style></head>
      <body><div id="outer"><div id="c">x</div></div></body></html>
    HTML
    # CSS Color 4: on `color` itself the keyword means `inherit`. Resolving it as "this element's
    # own colour" is a self-reference that recursed until the stack blew.
    expect(s.evaluate_script("getComputedStyle(document.getElementById('c')).color")).to eq('rgb(0, 0, 255)')
  end

  it 'expands a shorthand the same way whatever its origin' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#sheet { flex: initial }</style></head>
      <body><div id="sheet">a</div><div id="inline" style="flex: initial">b</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('sheet').flexGrow, g('inline').flexGrow, g('sheet').flexBasis, g('inline').flexBasis];
      })()
    JS
    # `flex: initial` is `0 1 auto`. The inline and stylesheet paths used different expanders, and
    # the generic one left the css-wide keyword in place — a string the layout engine can't parse.
    expect(got).to eq(['0', '0', 'auto', 'auto'])
  end

  it 'folds a keyword shorthand value to lowercase' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#u { overflow: HIDDEN }</style></head>
      <body><div id="u">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => { const c = getComputedStyle(document.getElementById('u')); return [c.overflow, c.overflowX, c.overflowY]; })()
    JS
    expect(got).to eq(['hidden', 'hidden', 'hidden'])
  end

  it 'reports a stylesheet value for any property, not just a captured few' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        #x { box-shadow: 0 0 4px red; transition-duration: .4s; text-decoration-line: underline;
             list-style-type: square }
      </style></head>
      <body><div id="x">x</div><div id="y">y</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        const x = g('x'), y = g('y');
        return [x.boxShadow, x.transitionDuration, x.textDecorationLine, x.listStyleType,
                y.boxShadow, y.transitionDuration];
      })()
    JS
    # The cascade captures every declaration, so an initial value is only ever reported for a
    # property the page really leaves unset. A hand-listed capture set made the answer for anything
    # outside it a guess — `box-shadow: none` for an element that plainly has one.
    #
    # The declared value is reported as written: Chrome serializes these in computed form
    # (`rgb(255, 0, 0) 0px 0px 4px`, `0.4s`), which needs a per-property serializer we only have for
    # the colour / background / length props resolved above. Reporting what the page declared is the
    # coarse part; claiming a value it doesn't have was the bug.
    expect(got).to eq(['0 0 4px red', '.4s', 'underline', 'square', 'none', '0s'])
  end

  it 'keeps an inline !important shorthand winning over an author rule' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#d { margin-left: 20px !important; border-left-color: lime !important }</style></head>
      <body><div id="d" style="margin: 0 !important; border: 1px solid red !important">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => { const c = getComputedStyle(document.getElementById('d')); return [c.marginLeft, c.borderLeftColor]; })()
    JS
    # The generic expander re-attaches `!important` per longhand only when its input carried one,
    # and the caller strips it first — so the declaration's own importance is what has to travel.
    expect(got).to eq(['0px', 'rgb(255, 0, 0)'])
  end

  it 'applies a re-declared inline property in source order' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="ord" style="margin-left:5px; margin:0; margin-left:7px">x</div></body></html>
    HTML
    # A declaration MAP keeps a re-declared property at its first position (that's where a block
    # serializes it), so iterating it fed the shorthand last and lost the 7px. Chrome: 7px.
    expect(s.evaluate_script("getComputedStyle(document.getElementById('ord')).marginLeft")).to eq('7px')
  end

  it 'lets list-style: none set the type as well as the image' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>ul { list-style-type: none }</style></head>
      <body><ul id="ls" style="list-style: none"></ul></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => { const c = getComputedStyle(document.getElementById('ls')); return [c.listStyleType, c.listStyleImage]; })()
    JS
    # A lone `none` sets BOTH (CSS Lists). Giving it to the image slot alone left the type at `disc`
    # — at inline precedence, beating the author rule.
    expect(got).to eq(['none', 'none'])
  end

  it 'says nothing rather than guessing when an unexpanded shorthand sets the longhand' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#t { transition: opacity 1s } #a { animation: spin 2s }</style></head>
      <body><div id="t">t</div><div id="a">a</div><div id="p">p</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('t').transitionDuration, g('a').animationName, g('p').transitionDuration];
      })()
    JS
    # We don't expand `transition` / `animation`, so the cascade never sees their longhands.
    # Reporting the initial there would be the confident-wrong-answer failure again (Chrome says
    # `1s` / `spin`); an empty string at least doesn't claim the element has no transition.
    expect(got).to eq(['', '', '0s'])
  end

  it 'normalises a colour initial the way a cascaded colour is normalised' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#g { color: rgb(0, 128, 0) }</style></head>
      <body><div id="g">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('g'));
        return [c.floodColor, c.lightingColor, c.outlineColor, c.caretColor, c.wordSpacing,
                c.borderTopLeftRadius, c.borderSpacing];
      })()
    JS
    # Chrome measured, all of them: a colour parser fed `black` where it expects `rgb()` fails, and
    # `outline-color` / `caret-color`'s `auto` means the element's own colour. The length initials
    # carry their unit.
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'rgb(0, 128, 0)', 'rgb(0, 128, 0)',
                       '0px', '0px', '0px'])
  end

  it 'gives a document whose body is not rendered a zero-height root' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>body { display: none }</style></head>
      <body><div>x</div></body></html>
    HTML
    # Chrome: 0. The layout pass stamps a box for the body either way, and the root took that
    # phantom flow.
    expect(s.evaluate_script('Math.round(document.documentElement.getBoundingClientRect().height)')).to eq(0)
  end

  it 'does not let the root element clip out-of-flow content' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        html { overflow-y: scroll } body { margin: 0 }
        #far { position: absolute; top: 400px; left: 0; width: 200px; height: 30px }
      </style></head>
      <body><div id="near">near</div><div id="far">far</div></body></html>
    HTML
    # The ROOT's overflow propagates to the viewport (CSS Overflow 3.3) and the element itself stays
    # `visible`. `html { overflow-y: scroll }` is near-universal in app CSS, and treating it as a
    # scroll container clipped to a root box only as tall as the body made every absolutely
    # positioned dropdown below that vanish from hit-testing.
    expect(s.evaluate_script("(document.elementFromPoint(60, 415) || {}).id")).to eq('far')
  end

  it 'leaves a tall panel alone when part of it is already showing' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 } #spacer { height: 100px } #panel { height: 1000px }
      </style></head>
      <body><div id="spacer"></div><div id="panel">panel</div></body></html>
    HTML
    s.find(:css, '#panel').click
    # WebDriver clicks the IN-VIEW centre point, so a box with any part in the viewport already has
    # a clickable one. Aligning its top instead scrolled the page on every click of anything taller
    # than the window.
    expect(s.evaluate_script('window.scrollY')).to eq(0)
  end

  it 'expands an inline background shorthand to its longhands' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="bg" style="background: #fff">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('bg'));
        return [c.backgroundColor, c.backgroundImage, c.backgroundRepeat, c.backgroundClip];
      })()
    JS
    # The inline path has to expand `background` exactly as the stylesheet path does; otherwise the
    # longhands never reach the cascade and the unexpanded-shorthand gate reports nothing at all —
    # an empty string to every `parseColor(getComputedStyle(el).backgroundColor)` in the page.
    expect(got).to eq(['rgb(255, 255, 255)', 'none', 'repeat', 'border-box'])
  end

  it 'does not let the body clip out-of-flow content either' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        body { overflow-x: hidden; margin: 0; height: 50px }
        #drop { position: absolute; top: 200px; left: 0; width: 200px; height: 30px }
      </style></head>
      <body><div id="drop">drop</div></body></html>
    HTML
    # Overflow propagates from the BODY to the viewport too, whenever the root took none of its own
    # (CSS Overflow 3.3) — the body's used value becomes `visible`. `body { overflow-x: hidden }` is
    # as common in app CSS as the `html` form.
    expect(s.evaluate_script("(document.elementFromPoint(10, 210) || {}).id")).to eq('drop')
  end

  it 'scrolls the nearest scrollable ancestor, not the page' do
    rows = (0...60).map {|i| %(<div class="row" id="it#{i}">row #{i}</div>) }.join
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 } #box { height: 200px; overflow: auto } .row { height: 40px }
      </style></head>
      <body><div id="box">#{rows}</div></body></html>
    HTML
    s.find(:css, '#it50').click
    # `scrollIntoView({block: 'nearest'})` walks the nearest-scrollable-ancestor chain, which is
    # what WebDriver's element-click runs. Scrolling only the document moved the PAGE and left the
    # row exactly as hidden as before.
    expect(s.evaluate_script('window.scrollY')).to eq(0)
    expect(s.evaluate_script("document.getElementById('box').scrollTop")).to be > 0
  end

  it 'keeps a scroll container overflow out of its ancestors scrollHeight' do
    rows = (0...60).map {|i| %(<div class="row">row #{i}</div>) }.join
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 } #box { height: 200px; overflow: auto } .row { height: 40px }
      </style></head>
      <body><div id="box">#{rows}</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      [document.documentElement.scrollHeight, document.body.scrollHeight,
       document.getElementById('box').scrollHeight]
    JS
    # Chrome measured: `[681, 200, 2400]` — the 2400px of rows is scrollable INSIDE the box and
    # nowhere else. (681 vs our 768 is the horizontal scrollbar we don't model; the body reports its
    # own 200px content height, not the viewport.)
    expect(got).to eq([768, 200, 2400])
  end

  it 'ignores an inline shorthand a browser would drop' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="bogus" style="overflow: inherit hidden">x</div><div id="plain">y</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('bogus').overflowX, g('plain').overflowX];
      })()
    JS
    # An unparsable declaration doesn't exist. Recording its name made the resolved-value gate treat
    # every longhand it could have set as unknowable. (Only checkable for a shorthand we can
    # expand: for one we can't — `transition: !!!` — we can't tell valid from invalid, so it still
    # suppresses. The wrong answer there is '' — "don't know" — not a confident one.)
    expect(got).to eq(['visible', 'visible'])
  end

  it 'applies a longhand re-declared after a shorthand in the inline block too' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="m" style="margin-left:7px; margin:1px; margin-left:9px">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const el = document.getElementById('m');
        return [el.style.marginLeft, getComputedStyle(el).marginLeft];
      })()
    JS
    # Chrome: 9px from both. The CSSOM block used to expand from the first-position MAP, so it
    # disagreed with the cascade about which declaration came last.
    expect(got).to eq(['9px', '9px'])
  end

  it 'normalises the SVG paint initials like every other colour' do
    s = session(short_page)
    got = s.evaluate_script(<<~JS)
      (() => { const c = getComputedStyle(document.getElementById('s')); return [c.fill, c.stroke]; })()
    JS
    # Chrome: `rgb(0, 0, 0)` / `none`. `fill` and `stroke` are colour-valued but don't end in
    # `-color`, so they missed the normalisation their siblings got.
    expect(got).to eq(['rgb(0, 0, 0)', 'none'])
  end

  it 'reports the UA stylesheet value, not the CSS initial' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body>
        <pre id="pre"><span id="in">x</span></pre><ol id="ol"></ol><ul id="ul"></ul>
        <a id="link" href="#">l</a><a id="bare">b</a><b id="b">b</b><em id="em">e</em>
        <del id="del">d</del><table><tr><th id="th">t</th></tr></table>
        <textarea id="ta"></textarea>
      </body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('pre').whiteSpace, g('in').whiteSpace, g('ol').listStyleType, g('ul').listStyleType,
                g('link').textDecorationLine, g('bare').textDecorationLine, g('b').fontWeight,
                g('em').fontStyle, g('del').textDecorationLine, g('th').textAlign, g('ta').whiteSpace];
      })()
    JS
    # All Chrome measured. Without a UA layer the initial-value fallback answered confidently and
    # wrongly for elements every page has — and contradicted the driver's own
    # `elementPreservesWhitespace`, which has always known `<pre>` preserves whitespace. The bare
    # `<a>` keeps the initial: the UA rule is `:any-link`, not every anchor. `<span>` inside the
    # `<pre>` INHERITS the UA value.
    expect(got).to eq(['pre', 'pre', 'decimal', 'disc', 'underline', 'none', '700',
                       'italic', 'line-through', 'center', 'pre-wrap'])
  end

  it 'keeps an inline !important shorthand from being clobbered within its own block' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#i { margin-top: 20px !important }</style></head>
      <body><div id="i" style="margin: 1px !important; margin-top: 2px">x</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const el = document.getElementById('i');
        return [el.style.marginTop, el.style.getPropertyPriority('margin-top')];
      })()
    JS
    # CSSOM "set a CSS declaration": within one block a later NORMAL declaration never clobbers an
    # `!important` one. Losing that also let the author rule win the cascade.
    expect(got).to eq(['1px', 'important'])
  end

  it 'keeps the all shorthand winner positional on the inline path' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="al" style="color: red; all: initial; color: blue">x</div></body></html>
    HTML
    # `all`'s cascade is decided by SOURCE position, which the declaration map encodes by moving a
    # property re-declared after `all` to the end. Expanding from the ordered list has to keep it.
    expect(s.evaluate_script("document.getElementById('al').style.getPropertyValue('color')")).to eq('blue')
  end

  it 'puts the UA stylesheet above inheritance, not below it' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        body { text-align: left; list-style-type: square }
        #red { color: red } #nw { white-space: nowrap }
      </style></head>
      <body>
        <div id="red"><a id="link" href="/x">l</a></div>
        <div id="nw"><pre id="pre">p</pre></div>
        <ol id="ol"></ol><table><tr><th id="th">t</th></tr></table>
        <pre id="init" style="white-space: initial">i</pre>
      </body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('link').color, g('pre').whiteSpace, g('ol').listStyleType, g('th').textAlign,
                g('init').whiteSpace];
      })()
    JS
    # The UA origin sits BELOW author rules and ABOVE inheritance, so an ancestor's declaration
    # never beats it (all Chrome measured). An explicit `initial` asks for the CSS initial and so
    # skips the UA origin — which is what makes the last one `normal`, not `pre`.
    expect(got).to eq(['rgb(0, 0, 238)', 'pre', 'decimal', 'center', 'normal'])
  end

  it 'inherits a longhand a stylesheet set through a shorthand' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>ul.nav { list-style: none }</style></head>
      <body><ul class="nav" id="nav"><li id="li">x</li></ul></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('nav').listStyleType, g('li').listStyleType];
      })()
    JS
    # `ul { list-style: none }` is in every nav stylesheet, and `x !== 'none'` is the branch page
    # code writes. The rule path expands the same shorthand registry the inline path does, so the
    # longhand exists in the cascade and the child inherits it.
    expect(got).to eq(['none', 'none'])
  end

  it 'computes a line width of zero while its style is none' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#o { outline-style: solid }</style></head>
      <body><div id="plain">p</div><div id="o">o</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('plain').outlineWidth, g('plain').columnRuleWidth, g('o').outlineWidth];
      })()
    JS
    # CSS UI: a line's used width is 0 while its style is `none`, which is the initial. mdn's
    # `medium` reported verbatim is a keyword `parseFloat` turns into NaN.
    expect(got).to eq(['0px', '0px', '3px'])
  end

  it 'reports the monospace family the UA sheet gives code and pre' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>body { font-family: Georgia, serif }</style></head>
      <body><code id="code">c</code><div id="d">d</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('code').fontFamily, g('d').fontFamily];
      })()
    JS
    # `<code>` is monospace whatever the page sets on the body — the dedicated font-family branch
    # returns before the generic UA lookup, so it has to consult it itself.
    expect(got).to eq(['monospace', 'Georgia, serif'])
  end

  it 'keeps the UA sheet metadata out of the property space' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><a id="link" href="/x">l</a></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const c = getComputedStyle(document.getElementById('link'));
        return [typeof c.when, c.getPropertyValue('when')];
      })()
    JS
    # Every key of the UA value map is reachable as a property name, so the `:any-link` predicate
    # can't live there — a caller treating the answer as a CSS string would get a function. (Chrome
    # answers an unknown name with `undefined`; our declaration proxy answers '' for any string key,
    # a separate bounded gap. What matters here is that it is not a function.)
    expect(got).to eq(['string', ''])
  end

  it 'hit-tests the root across the whole canvas' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>body { margin: 0 } #s { height: 50px }</style></head>
      <body><div id="s">s</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      [Math.round(document.documentElement.getBoundingClientRect().height),
       (document.elementFromPoint(10, 400) || {}).tagName]
    JS
    # Chrome measured `[50, "HTML"]`: the root's client rect is only as tall as its content, but it
    # still paints — and hit-tests — the canvas across the whole viewport.
    expect(got).to eq([50, 'HTML'])
  end

  it 'says nothing for either side a flow-relative shorthand might have set' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>#d { border-block-end: 3px solid red }</style></head>
      <body><div id="d">d</div><div id="p">p</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('d').borderBottomStyle, g('d').borderTopStyle, g('p').borderTopStyle];
      })()
    JS
    # We don't expand flow-relative shorthands, and mdn's table names whichever physical side the
    # value would RESOLVE to, which depends on the writing mode. So the whole family is unknowable
    # rather than confidently `none` for the side that is actually solid (Chrome: solid / none) —
    # an element nothing touches still reports the initial.
    expect(got).to eq(['', '', 'none'])
  end

  it 'keeps a written inline block agreeing with how it was read' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><div id="a">a</div><div id="b">b</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a'), b = document.getElementById('b');
        a.setAttribute('style', 'margin-left: 7px; margin: 1px; margin-left: 9px');
        const beforeA = a.style.marginLeft;
        a.style.color = 'red';                       // any write re-serializes the whole block
        b.setAttribute('style', 'color: red !important; color: blue');
        const beforeB = [b.style.color, b.style.getPropertyPriority('color')];
        b.style.width = '5px';
        return [beforeA, a.style.marginLeft, beforeB, [b.style.color, b.style.getPropertyPriority('color')]];
      })()
    JS
    # Chrome keeps both across the write. The read path parses in SOURCE ORDER; a write path on the
    # map form rebuilds the block from a different parse and silently changes values that were
    # already correct.
    expect(got).to eq(['9px', '9px', ['red', 'important'], ['red', 'important']])
  end

  it 'keeps a rule !important from being clobbered inside its own block' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        #imp { margin: 1px !important; margin-top: 2px }
        #ov { overflow: hidden !important; overflow: auto }
      </style></head>
      <body><div id="imp">i</div><div id="ov">o</div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = id => getComputedStyle(document.getElementById(id));
        return [g('imp').marginTop, g('ov').overflowX];
      })()
    JS
    # Chrome: `1px` / `hidden`. The inline reader already had this rule; the stylesheet side has to
    # agree, all the more now that every declaration is captured.
    expect(got).to eq(['1px', 'hidden'])
  end

  it 'lets revert fall through to inheritance when the UA sheet has nothing to say' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><body><pre id="pre">x<span id="sp" style="white-space: revert">y</span></pre></body></html>
    HTML
    # `revert` rolls back to the UA origin — and a `<span>` has no UA `white-space`, so what it
    # reverts to is what it inherits. Chrome: `pre`.
    expect(s.evaluate_script("getComputedStyle(document.getElementById('sp')).whiteSpace")).to eq('pre')
  end
end
