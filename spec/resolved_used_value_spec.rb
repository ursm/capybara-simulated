# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSSOM's RESOLVED value is the USED one for the box properties — `width` / `height`, the
# paddings, the border widths and the margins — whenever the element has a box. Everything
# else resolves to its computed value.
#
# Before this the style side answered with whatever the AUTHOR wrote: `10em`, `50%`, or `''`
# for an auto width. So a page that read a size back through the style API got a string it
# could not do arithmetic on, and the driver disagreed with itself — `getBoundingClientRect`
# had the real number all along, from the same box. There is ONE geometry; this is the other
# view of it.
#
# The figures below are Chrome 151's, measured on this exact page (headless, 1024x768): all
# fifteen matched byte for byte.
RSpec.describe 'CSSOM resolved values' do
  def session_for(body)
    html = <<~HTML
      <!DOCTYPE html><html><head><style>
        body { margin: 0; width: 800px; font: 16px Arial }
        .box { padding: 1em; border: 2px solid; box-sizing: border-box }
      </style></head><body>#{body}</body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  def read(session, id, *props)
    session.evaluate_script(
      "(() => { const c = getComputedStyle(document.getElementById('#{id}')); " \
      "return #{props.inspect}.map(k => c[k]); })()"
    )
  end

  # A percentage width is USED against the containing block, and `box-sizing: border-box`
  # makes the reported figure the BORDER box — Chrome reports the 400px the element occupies,
  # not the 380px of content inside it.
  it 'resolves a percentage width to the used border box' do
    s = session_for('<div id="t" class="box" style="width:50%"></div>')
    expect(read(s, 't', 'width', 'paddingLeft', 'borderLeftWidth')).to eq(['400px', '16px', '2px'])
  end

  # `auto` is the one an author can't compute for themselves, and the one every layout script
  # actually wants: the width the block took.
  it 'resolves an auto width to the width the block took' do
    s = session_for('<div id="t" class="box"></div>')
    expect(read(s, 't', 'width')).to eq(['800px'])
  end

  # An `auto` MARGIN reports the distributed figure, not the keyword: centring a 160px box in
  # 800px leaves 279px on the `1px` border's each side. Percentage padding resolves against
  # the containing block's WIDTH, on every side.
  it 'resolves auto margins and percentage padding to their distributed figures' do
    s = session_for('<div id="t" style="width:10em; padding:5%; margin:0 auto; border:1px solid"></div>')
    expect(read(s, 't', 'width', 'paddingLeft', 'marginLeft', 'marginRight'))
      .to eq(['160px', '40px', '279px', '279px'])
  end

  # `min-width` / `max-width` are never used values, so the clamp shows up in `width` itself.
  it 'reports a clamped width as the clamped figure' do
    s = session_for('<div id="t" style="width:10em; max-width:50px"></div>')
    expect(read(s, 't', 'width')).to eq(['50px'])
  end

  # With NO BOX there is no used value, and the resolved value falls back to the COMPUTED one:
  # a relative length is still absolutized (`10em` → `160px`, `max-width: 30em` → `480px`),
  # but `height: auto` stays `auto` and a percentage padding stays `2%` — a browser has nothing
  # to resolve them against either.
  it 'reports the computed value for an element with no box' do
    s = session_for('<div id="t" style="display:none; width:10em; height:auto; max-width:30em; padding:2%"></div>')
    expect(read(s, 't', 'width', 'height', 'maxWidth', 'paddingLeft'))
      .to eq(['160px', 'auto', '480px', '2%'])
  end

  # `width` does not APPLY to a non-replaced inline box, and `display: contents` generates no
  # box at all — so neither owes a used value, and both report the computed `10em`.
  it 'reports the computed width where a box has no used size' do
    s = session_for('<span id="i" style="width:10em">x</span>' \
                    '<div id="c" style="display:contents; width:10em"></div>')
    expect([read(s, 'i', 'width'), read(s, 'c', 'width')]).to eq([['160px'], ['160px']])
  end

  # `min-*` / `max-*` clamp the size the box actually took, which for an AUTO height is only known
  # once the flow has been laid out. Clamping earlier — while the height is still the 0 placeholder
  # the flow back-fills — froze the box at its `min-height` however tall its content grew, and
  # `min-height: 100vh` on a page shell put every following sibling under the fold. Chrome 151 on
  # this page: 300 and 50.
  it 'clamps the height the flow produced, not the placeholder it starts from' do
    s = session_for('<div id="min" style="min-height:100px"><div style="height:300px"></div></div>' \
                    '<div id="max" style="max-height:50px"><div style="height:300px"></div></div>')
    rect = ->(id) { s.evaluate_script("document.getElementById('#{id}').getBoundingClientRect().height") }
    expect([rect.call('min'), rect.call('max')]).to eq([300, 50])
  end

  # Auto-margin distribution is only for a box CSS distributes for — an in-flow block (§10.3.3) or
  # an abspos stretched between both insets (§10.3.7). A float's `auto` margin is zero (§10.3.5),
  # an inline's stays the keyword, and an over-constrained block balances on the trailing side.
  # Every figure here is Chrome 151's on the same page.
  it 'distributes an auto margin only where CSS distributes it' do
    s = session_for(<<~HTML)
      <div style="width:500px; position:relative; height:300px">
        <div id="float" style="float:left; width:100px; margin:0 auto"></div>
        <div id="block" style="width:100px; margin:0 auto"></div>
        <div id="one" style="position:absolute; left:0; width:100px; margin:0 auto"></div>
        <div id="both" style="position:absolute; left:0; right:0; width:100px; margin:0 auto"></div>
        <div id="over" style="width:600px; margin:0 auto"></div>
        <span id="inline" style="margin-left:auto">x</span>
      </div>
    HTML
    out = s.evaluate_script(<<~JS)
      (() => {
        const q = id => { const e = document.getElementById(id), c = getComputedStyle(e);
          return [e.getBoundingClientRect().x, c.marginLeft, c.marginRight]; };
        return {float: q('float'), block: q('block'), one: q('one'),
                both: q('both'), over: q('over'), inline: q('inline')};
      })()
    JS
    expect(out['float']).to  eq([0, '0px', '0px'])       # §10.3.5 — and the box does NOT move
    expect(out['block']).to  eq([200, '200px', '200px'])
    expect(out['one']).to    eq([0, '0px', '0px'])       # one inset: nothing to distribute
    expect(out['both']).to   eq([200, '200px', '200px']) # §10.3.7
    expect(out['over'][1..]).to eq(['0px', '-100px'])    # over-constrained: the remainder is real
    expect(out['inline'][1..]).to eq(['auto', '0px'])    # an inline margin has no used value
  end

  # A CUSTOM property computes to the token stream that was written — Chrome hands `--gap: 2em`
  # back as `2em`. Absolutizing it changed what design-token code reads back out.
  it 'leaves a custom property as written' do
    s = session_for('<div id="t" style="--gap:2em; --raw:3em 4px; letter-spacing:2em"></div>')
    out = s.evaluate_script(
      "(() => { const c = getComputedStyle(document.getElementById('t')); " \
      "return [c.getPropertyValue('--gap'), c.getPropertyValue('--raw'), c.letterSpacing]; })()"
    )
    expect(out).to eq(['2em', '3em 4px', '32px'])       # …while a real property still absolutizes
  end

  # `inline-size` / `block-size` name the same two boxes by FLOW, and swap with the writing mode.
  it 'reports the flow-relative sizes as the same used boxes' do
    s = session_for('<div id="h" style="box-sizing:border-box; width:50%; padding:1em; border:2px solid">x</div>' \
                    '<div id="v" style="writing-mode:vertical-rl; width:120px; height:60px"></div>')
    out = s.evaluate_script(
      "(() => { const q = id => { const c = getComputedStyle(document.getElementById(id)); " \
      "return [c.inlineSize, c.blockSize]; }; return [q('h'), q('v')]; })()"
    )
    expect(out).to eq([['400px', '54px'], ['60px', '120px']])
  end

  # Absolutizing a computed value is TOKEN-wise, and a quoted string is DATA rather than a value
  # to rewrite: `quotes` carries the punctuation a `::before` renders and `grid-template-areas`
  # the names a rule refers to, so `</1em>` and the area called `1em` have to survive intact.
  # (Chrome 151 reports exactly what was written for both, and `3em` next to them as `48px`.)
  it 'absolutizes the lengths outside a quoted string and none inside one' do
    s = session_for('<style>#t { quotes: "<1em>" "</1em>" }</style>' \
                    '<div id="t" style="letter-spacing:3em; grid-template-areas:\'a 1em\'"></div>')
    expect(read(s, 't', 'letterSpacing', 'quotes', 'gridTemplateAreas'))
      .to eq(['48px', '"<1em>" "</1em>"', '"a 1em"'])
  end
end
