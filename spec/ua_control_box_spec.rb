require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The UA stylesheet's form-control box. A control's border, padding, background and font come from
# the UA sheet, and they are part of its BOX — a `<button>` that measures its label but not its
# chrome is 42px too narrow, and every one of those errors lands in hit-testing, `obscured?` and
# how much room a row of controls takes.
#
# Every number here is real Chrome 137's, read off the same markup with
# `--headless --dump-dom` over a `file://` page at the default font. Where a control's intrinsic
# size still comes from a constant rather than from its attributes (a text `<input>`'s `size`, a
# `<textarea>`'s `cols`/`rows`, the widest `<option>` in a `<select>`), the DEFAULT case is what
# matches and the attribute case is named as the known gap.
RSpec.describe 'UA stylesheet: the form-control box' do
  def page_with(markup)
    html = <<~HTML
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><style>body { margin: 0; font: 16px sans-serif }</style></head>
      <body>#{markup}</body></html>
    HTML
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  def size(s, id)
    s.evaluate_script(<<~JS)
      (r => [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100])(
        document.getElementById('#{id}').getBoundingClientRect())
    JS
  end

  def style(s, id, *props)
    s.evaluate_script(<<~JS)
      (cs => [#{props.map {|p| "cs[#{p.inspect}]" }.join(', ')}])(
        getComputedStyle(document.getElementById('#{id}')))
    JS
  end

  it 'gives a button its label plus its chrome' do
    s = page_with('<button id="b">Pay now</button><button id="e"></button>')
    # 51.13 of label + 12 of padding + 4 of border. An EMPTY button is the chrome alone — Chrome
    # keeps the 6px of vertical edges rather than collapsing the box to nothing.
    expect(size(s, 'b')).to eq([67.14, 21])       # Chrome: 67.13 x 21
    expect(size(s, 'e')).to eq([16, 6])
  end

  it 'sizes a button input from its value, and the UA label when it has none' do
    s = page_with('<input id="go" type="submit" value="Go"><input id="sub" type="submit">' \
                  '<input id="res" type="reset"><input id="empty" type="button" value="">')
    expect(size(s, 'go')).to    eq([33.79, 21])   # Chrome: 33.78 x 21
    expect(size(s, 'sub')).to   eq([57.5,  21])   # Chrome: 57.48 x 21 ("Submit")
    expect(size(s, 'res')).to   eq([50.83, 21])
    expect(size(s, 'empty')).to eq([16, 21])
  end

  it 'gives every control family the box Chrome gives it' do
    s = page_with('<input id="t"><textarea id="a"></textarea><select id="s"><option>one</option></select>' \
                  '<input id="c" type="checkbox"><input id="f" type="file">' \
                  '<input id="r" type="range"><input id="col" type="color">')
    expect(size(s, 't')).to   eq([185, 21])
    expect(size(s, 'a')).to   eq([201, 42])
    expect(size(s, 's')).to   eq([45, 19])
    expect(size(s, 'c')).to   eq([13, 13])
    expect(size(s, 'f')).to   eq([253, 21])
    expect(size(s, 'r')).to   eq([129, 16])
    expect(size(s, 'col')).to eq([50, 27])
  end

  it 'sizes a select from its widest option' do
    s = page_with('<select id="e"></select><select id="a"><option>a</option></select>' \
                  '<select id="b"><option>bbbb</option></select>' \
                  '<select id="g"><optgroup><option>a</option><option label="a much longer option label">x</option></optgroup></select>' \
                  '<select id="l" size="4"><option>one</option></select>')
    # Chrome: the widest option plus room for the arrow — 22 empty, then 30 / 52 / 179 — and a
    # listbox, which has no arrow, is that width plus 19 (43.25).
    expect(size(s, 'e')).to eq([22, 19])
    expect(size(s, 'a')).to eq([30, 19])
    expect(size(s, 'b')).to eq([52, 19])
    # …counting an `<optgroup>`'s options — indented 15px under it, as Chrome draws them — and
    # taking an option's `label` attribute over its text.
    expect(size(s, 'g')).to eq([194, 19])
    expect(size(s, 'l')).to eq([43.25, 70])
  end

  it 'resets the whole font, not just the size and the family' do
    # The UA rule is the `font` SHORTHAND — `font: 400 13.3333px Arial` — so a control inside bold,
    # italic, coloured, letter-spaced text still reports 400 / normal / black / normal, and a page
    # with a root `line-height` does not make its buttons taller. All Chrome-measured.
    s = page_with('<style>body { line-height: 1.5; color: rgb(200, 0, 0); letter-spacing: 2px }' \
                  '#h { font-weight: bold; font-style: italic }</style>' \
                  '<div id="h"><button id="b">Pay now</button><input id="t"></div>')
    expect(style(s, 'b', 'fontWeight', 'fontStyle', 'lineHeight', 'color', 'letterSpacing'))
      .to eq(['400', 'normal', 'normal', 'rgb(0, 0, 0)', 'normal'])
    expect(size(s, 'b')).to eq([67.14, 21])   # Chrome: 67.13 x 21 — not the 27 a 1.5 line box gives
    expect(size(s, 't')).to eq([185, 21])
  end

  it 'takes an image input for the image it is, and an unknown type for a text field' do
    s = page_with('<input id="im" type="image"><input id="im2" type="image" width="100" height="40">' \
                  '<input id="u" type="wibble"><input id="k" type="constructor">')
    # Chrome: an `image` has no chrome and no box until something decodes, and takes the
    # `width`/`height` content attributes as presentation hints the way an `<img>` does.
    expect(size(s, 'im')).to  eq([0, 0])
    expect(size(s, 'im2')).to eq([100, 40])
    expect(style(s, 'im', 'borderTopStyle', 'backgroundColor')).to eq(['none', 'rgba(0, 0, 0, 0)'])
    # An unknown type is a text field — including one that names an `Object.prototype` member,
    # which reached the prototype of the type table and measured a FUNCTION as its label.
    expect(size(s, 'u')).to eq([185, 21])
    expect(size(s, 'k')).to eq([185, 21])
  end

  it 'floors a border box at the border and padding inside it' do
    # Chrome: `width: 5px` on a `<button>` is 16 — its own chrome — not 5. A control is
    # `border-box`, so this is newly reachable on every sized button and select.
    s = page_with('<button id="b" style="width: 5px">x</button>' \
                  '<input id="s" type="submit" value="Go" style="max-width: 10px">')
    expect(size(s, 'b')).to eq([16, 21])
    expect(size(s, 's')).to eq([16, 21])
  end

  it 'resolves a CSS-wide keyword on a control the way the computed value does' do
    # `revert` means the UA sheet's value and `inherit` the parent's — and the BOX has to agree
    # with `getComputedStyle` about it. The layout side read the cascade directly, where a keyword
    # parses as no length at all, so the edge silently became 0. All three Chrome-measured.
    s = page_with('<div style="border: 10px solid red; padding: 7px">' \
                  '<button id="r" style="padding: revert">x</button>' \
                  '<button id="h" style="border-width: inherit; border-style: inherit">x</button>' \
                  '<button id="i" style="padding: initial">x</button></div>')
    expect(size(s, 'r')).to eq([22.67, 21])
    expect(size(s, 'h')).to eq([38.67, 37])
    expect(size(s, 'i')).to eq([10.67, 19])
  end

  it 'reports the chrome through getComputedStyle, where the author cascade can override it' do
    s = page_with('<button id="b">x</button><input id="t"><textarea id="a"></textarea>' \
                  '<select id="s"></select><select id="l" size="4"></select>')
    expect(style(s, 'b', 'borderTopWidth', 'borderTopStyle', 'paddingLeft', 'backgroundColor'))
      .to eq(['2px', 'outset', '6px', 'rgb(239, 239, 239)'])
    expect(style(s, 't', 'borderTopStyle', 'borderTopColor', 'boxSizing'))
      .to eq(['inset', 'rgb(118, 118, 118)', 'content-box'])
    expect(style(s, 'a', 'fontFamily', 'fontSize', 'paddingTop')).to eq(['monospace', '13.3333px', '2px'])
    # A dropdown is a grey button face; a LISTBOX is a white scrolling pane.
    expect(style(s, 's', 'backgroundColor', 'boxSizing')).to eq(['rgb(239, 239, 239)', 'border-box'])
    expect(style(s, 'l', 'backgroundColor')).to eq(['rgb(255, 255, 255)'])
  end

  it 'lets an author declaration outrank the UA value' do
    s = page_with('<style>#b { border: 0; padding: 0; font: 16px sans-serif; background: red }</style>' \
                  '<button id="b">Pay now</button>')
    expect(style(s, 'b', 'borderTopWidth', 'paddingLeft', 'fontSize', 'backgroundColor'))
      .to eq(['0px', '0px', '16px', 'rgb(255, 0, 0)'])
    # …and the box follows the cascade, not the UA sheet: the label alone, in the author's font.
    expect(size(s, 'b')).to eq([61.37, 18])   # Chrome: 61.38 x 18
  end

  it 'keeps a control out of its parent font, as a browser does' do
    s = page_with('<div style="font-size: 30px"><button id="b">x</button><span id="p">x</span></div>')
    expect(style(s, 'b', 'fontSize')).to eq(['13.3333px'])
    expect(style(s, 'p', 'fontSize')).to eq(['30px'])
  end

  it 'measures a sized control the way its own box-sizing says' do
    # Chrome: a `<button>` / `<select>` is `border-box` — its declared height is the WHOLE box —
    # while a text `<input>` is `content-box`, so its border and padding sit outside the 100px.
    s = page_with('<style>#b, #s { height: 20px } #t { width: 100px }</style>' \
                  '<button id="b">x</button><select id="s"></select><input id="t">')
    expect(size(s, 'b')[1]).to eq(20)
    expect(size(s, 's')[1]).to eq(20)
    expect(size(s, 't')[0]).to eq(108)
  end

  it 'gives a checkbox and a radio the margins the UA gives them' do
    s = page_with('<label><input id="c" type="checkbox"><input id="r" type="radio"><span id="l">Yes</span></label>')
    # Chrome's `margin: 3px 3px 3px 4px` is the only thing between the box and the word beside it —
    # and a radio's left margin is 5px, not the checkbox's 4px.
    expect(style(s, 'c', 'marginLeft', 'marginTop')).to eq(['4px', '3px'])
    expect(style(s, 'r', 'marginLeft', 'marginTop')).to eq(['5px', '3px'])
    # KNOWN GAP, not this sheet's: the inline flow ignores an ATOMIC inline's margins — an
    # `<img style="margin: 0 10px">` and an `inline-block` span lose them too — so the checkbox
    # sits at x=0 where Chrome puts it at 4, and the word beside it at 13 rather than 20.
    expect(size(s, 'c')).to eq([13, 13])
  end

  it 'makes a listbox as tall as the rows it shows' do
    s = page_with('<select id="s4" size="4"><option>one</option></select>' \
                  '<select id="m" multiple><option>one</option></select>' \
                  '<select id="one" multiple size="1"><option>one</option></select>')
    expect(size(s, 's4')[1]).to eq(70)   # Chrome: 70 (4 rows of 17, plus the 1px border)
    expect(size(s, 'm')[1]).to  eq(70)   # a bare `multiple` shows 4 rows
    # HTML's display size, not the presence of `multiple`: an explicit `size="1"` is one row, and
    # Chrome draws it as a dropdown — grey face and all. (Its WIDTH there is a Chrome oddity we
    # don't reproduce: 83 for a short option, where the same select without `multiple` is 45.)
    expect(size(s, 'one')[1]).to eq(19)
    expect(style(s, 'one', 'backgroundColor')).to eq(['rgb(239, 239, 239)'])
  end

  it 'does not render a hidden input at all' do
    s = page_with('<input id="h" type="hidden" value="x"><div id="d">after</div>')
    expect(style(s, 'h', 'display')).to eq(['none'])
    expect(size(s, 'h')).to eq([0, 0])
    expect(s.evaluate_script("document.getElementById('d').getBoundingClientRect().top")).to eq(0)
  end
end
