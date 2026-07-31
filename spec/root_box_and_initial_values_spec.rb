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
end
