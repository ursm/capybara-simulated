# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Table layout. A table's geometry falls out of no other formatting context — a
# column is as wide as the widest cell in that column across EVERY row, and the
# table itself is shrink-to-fit — so before this it was approximated by laying each
# row out as an equal-share flex row, which got both wrong: every column the same
# width whatever it held, and the table always as wide as the page.
#
# The algorithm is CSS Tables 3 §"Distributing width to columns", the one Chrome
# implements, and every expectation below was derived from a Chrome 137 measurement
# of the same markup (headless, 1024x768). They are written as FORMULAS over widths
# measured in the page itself rather than as the pixel figures Chrome printed: the
# figures depend on which face fontconfig serves for Arial, the formulas don't, and
# it is the formula that this file exists to pin. (The pixel figures are in the
# comments, from Liberation Sans — what both Chrome and we get on Linux.)
RSpec.describe 'table layout' do
  # Lay `body` out and report, in one pass: the boxes of `selectors`, the width of
  # each string in `probes` in the same font the cells use, and the height of a
  # plain one-line block. The probes sit at the END of the body, so they add a line
  # below everything measured and disturb none of it.
  def measure(body, selectors, probes: [], bold_probes: [], style: 'margin:0;font:16px Arial')
    probe_markup = +'<div id="__line">x</div><span id="__probe" style="white-space:pre"></span>'
    html    = %(<html><head><meta charset="utf-8"></head><body style="#{style}">#{body}#{probe_markup}</body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    js = <<~JS
      (function () {
        var probe = document.getElementById('__probe'), text = {};
        function widths(list, weight) {
          probe.style.fontWeight = weight;
          list.forEach(function (t) { probe.textContent = t; text[weight + ' ' + t] = probe.getBoundingClientRect().width; });
        }
        widths(#{probes.to_json}, 'normal');
        widths(#{bold_probes.to_json}, 'bold');
        probe.remove();
        return JSON.stringify({
          boxes: #{selectors.to_json}.map(function (sel) {
            var r = document.querySelector(sel).getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
          text: text,
          line: document.getElementById('__line').getBoundingClientRect().height
        });
      })()
    JS
    m = JSON.parse(session.evaluate_script(js))
    [m['boxes'], Text.new(m['text']), m['line']]
  end

  # The measured width of a string, and of the widest word in it (its min-content).
  Text = Struct.new(:table) do
    def [](s, weight = 'normal') = table.fetch("#{weight} #{s}")
    def word(s) = s.split.map {|w| self[w] }.max
  end

  # The UA stylesheet's cell padding and table border-spacing, which are in every
  # figure a browser reports for a table.
  PAD     = 2   # 1px on each side of a cell
  SPACING = 2

  it 'sizes a column from the widest cell in it and shrinks the table to fit' do
    body = <<~HTML
      <table id="t"><tr id="r1"><td id="a">A</td><td id="b">Wider cell</td></tr>
      <tr id="r2"><td id="c">Another one</td><td id="d">B</td></tr></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#r1', '#a', '#b', '#r2', '#c'],
                                probes: ['A', 'Wider cell', 'Another one', 'B'])
    t, r1, a, b, r2, c = boxes
    # Column 1 comes from "Another one" in the SECOND row, not from the "A" above it.
    col1 = text['Another one'] + PAD          # Chrome: 89.19
    col2 = text['Wider cell']  + PAD          # Chrome: 72.23
    expect([a[2], c[2]]).to all(be_within(0.01).of(col1))
    expect(b[2]).to be_within(0.01).of(col2)
    # Shrink-to-fit: the table is its columns plus the spacing around and between
    # them — 167 wide, not the 1024 a block would have taken.
    expect(t[2]).to be_within(0.01).of(col1 + col2 + SPACING * 3)
    expect(t[3]).to eq(SPACING * 3 + (line + PAD) * 2)     # Chrome: 46
    expect([t[0], r1[0], r1[1], a[0]]).to eq([0, SPACING, SPACING, SPACING])
    expect(b[0]).to be_within(0.01).of(SPACING + col1 + SPACING)
    expect(r2[1]).to eq(SPACING + (line + PAD) + SPACING)
  end

  # Chrome measured: a 400px table whose two columns want 12.67 and 108.7 gives them
  # 41.13 and 352.88 — the surplus in proportion to what each column WANTS, neither
  # equally nor in proportion to what is left over.
  it 'shares a surplus over the columns in proportion to their max-content' do
    body = '<table id="t" style="width:400px"><tr><td id="a">A</td><td id="b">Wider cell here</td></tr></table>'
    boxes, text = measure(body, ['#t', '#a', '#b'], probes: ['A', 'Wider cell here'])
    t, a, b = boxes
    assignable = 400 - SPACING * 3
    max_a = text['A'] + PAD
    max_b = text['Wider cell here'] + PAD
    expect(t[2]).to eq(400)
    expect(a[2]).to be_within(0.01).of(assignable * max_a / (max_a + max_b))
    expect(b[2]).to be_within(0.01).of(assignable * max_b / (max_a + max_b))
  end

  # The middle branch of the same algorithm: too narrow for max-content, so every
  # column moves from its own min-content toward its own max by the SAME fraction.
  it 'interpolates from min-content toward max-content when the table is squeezed' do
    a_text = 'The quick brown fox jumps over'
    b_text = 'the lazy dog again and again'
    body = <<~HTML
      <div style="width:200px"><table id="t"><tr><td id="a">#{a_text}</td><td id="b">#{b_text}</td></tr></table></div>
    HTML
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: [a_text, b_text] + (a_text + ' ' + b_text).split)
    t, a, b = boxes
    assignable = 200 - SPACING * 3
    mins = [text.word(a_text) + PAD, text.word(b_text) + PAD]
    maxs = [text[a_text] + PAD, text[b_text] + PAD]
    ratio = (assignable - mins.sum) / (maxs.sum - mins.sum)
    expect(t[2]).to eq(200)
    expect(a[2]).to be_within(0.01).of(mins[0] + (maxs[0] - mins[0]) * ratio)   # Chrome: 101.81
    expect(b[2]).to be_within(0.01).of(mins[1] + (maxs[1] - mins[1]) * ratio)   # Chrome: 92.19
    expect(a[3]).to eq(line * (maxs[0] / a[2]).ceil + PAD)                      # wrapped, three lines
  end

  it 'grows the columns a cell spans only by what they are short of' do
    span_text = 'spanning both columns wide'
    body = <<~HTML
      <table id="t"><tr><td id="s" colspan="2">#{span_text}</td></tr>
      <tr><td id="x">x</td><td id="y">y</td></tr></table>
    HTML
    boxes, text = measure(body, ['#t', '#s', '#x', '#y'], probes: [span_text, 'x', 'y'])
    t, s, x, y = boxes
    # The spanning cell needs its width MINUS the spacing it swallows; the two
    # columns split the shortfall equally, because they wanted the same.
    each = (text[span_text] + PAD - SPACING) / 2
    expect([x[2], y[2]]).to all(be_within(0.01).of(each))                       # Chrome: 100.95
    expect(s[2]).to be_within(0.01).of(each * 2 + SPACING)                      # Chrome: 203.91
    expect(t[2]).to be_within(0.01).of(each * 2 + SPACING * 3)
  end

  it 'stretches a rowspan cell over the rows it covers' do
    body = <<~HTML
      <table id="t"><tr><td id="tall" rowspan="2">tall</td><td id="one">one</td></tr>
      <tr><td id="two">two</td></tr></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#tall', '#one', '#two'])
    t, tall, one, two = boxes
    row = line + PAD
    expect(tall[3]).to eq(row * 2 + SPACING)                                    # Chrome: 42
    expect(t[3]).to eq(row * 2 + SPACING * 3)
    # The spanning cell holds column 1 in BOTH rows, so the second row's only cell
    # sits in column 2 rather than at the table's left edge.
    expect(two[0]).to eq(one[0])
    expect(two[1]).to eq(one[1] + row + SPACING)
  end

  it 'halves the shared borders when the table collapses them' do
    body = <<~HTML
      <table id="t" style="border-collapse:collapse">
      <tr><td id="a" style="border:1px solid">A</td><td id="b" style="border:1px solid">B</td></tr>
      <tr><td id="c" style="border:1px solid">C</td><td id="d" style="border:1px solid">D</td></tr></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: %w[A C])
    t, a, b = boxes
    # A collapsed cell owns HALF of each shared border, and the border-spacing is
    # gone: 14.56 = the wider of the column's two letters + 2 padding + 0.5 + 0.5.
    col = [text['A'], text['C']].max + PAD + 1
    expect(a[2]).to be_within(0.01).of(col)                                     # Chrome: 14.56
    expect(a[0]).to eq(0.5)                                                     # the table holds the outer half
    expect(b[0]).to be_within(0.01).of(0.5 + col)
    expect(t[0]).to eq(0)
    expect(t[2]).to be_within(0.02).of(col * 2 + 1)                             # Chrome: 30.13
    expect(a[3]).to eq(line + PAD + 1)                                          # Chrome: 21
    expect(t[3]).to eq((line + PAD + 1) * 2 + 1)                                # Chrome: 43
  end

  it 'puts the declared border-spacing around and between every cell' do
    body = <<~HTML
      <table id="t" style="border-spacing:10px 5px">
      <tr><td id="a" style="border:2px solid">A</td><td id="b" style="border:2px solid">B</td></tr>
      <tr><td id="c" style="border:2px solid">C</td><td id="d" style="border:2px solid">D</td></tr></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#a', '#b', '#c'])
    t, a, b, c = boxes
    cell_h = line + PAD + 4          # the line, the UA padding, and both borders
    expect(a[0]).to eq(10)
    expect(a[1] - t[1]).to eq(5)
    expect(a[3]).to eq(cell_h)                                                  # Chrome: 24
    expect(b[0]).to be_within(0.01).of(10 + a[2] + 10)
    expect(c[1] - a[1]).to eq(cell_h + 5)
    expect(t[3]).to eq(cell_h * 2 + 15)                                         # Chrome: 63
  end

  it 'lays the caption above the rows and inside the table box' do
    body = <<~HTML
      <table id="t"><caption id="cap">The caption</caption>
      <thead id="head"><tr><th id="th">Header</th><th>Second</th></tr></thead>
      <tbody id="body"><tr><td id="td">body</td><td>cell</td></tr></tbody>
      <tfoot id="foot"><tr><td>foot</td><td>x</td></tr></tfoot></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#cap', '#head', '#th', '#body', '#td', '#foot'],
                                probes: ['body'], bold_probes: ['Header'])
    t, cap, head, th, body_group, td, foot = boxes
    row = line + PAD
    expect(cap[1]).to eq(t[1])                       # the caption's top IS the table's top
    expect(cap[2]).to be_within(0.01).of(t[2])       # and it is as wide as the whole table
    expect(cap[3]).to eq(line)
    expect(t[3]).to eq(line + SPACING * 4 + row * 3)                            # Chrome: 86
    # A row group's box wraps only its own rows, and it is the header's BOLD text
    # that sizes column 1 — the widest cell in a column is not the widest string.
    expect(head[1]).to eq(cap[1] + line + SPACING)
    expect(head[3]).to eq(row)
    expect(td[2]).to be_within(0.01).of(th[2])
    expect(th[2]).to be_within(0.01).of([text['Header', 'bold'], text['body']].max + PAD)   # Chrome: 56.25
    expect(foot[1] - body_group[1]).to eq(row + SPACING)
  end

  it 'sizes fixed-layout columns from the first row and wraps the content to them' do
    cell_text = 'a very long piece of text here'
    body = <<~HTML
      <table id="t" style="table-layout:fixed;width:300px">
      <tr><td id="a" style="width:100px">#{cell_text}</td><td id="b">b</td></tr></table>
    HTML
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: [cell_text])
    t, a, b = boxes
    expect(t[2]).to eq(300)
    expect(a[2]).to eq(100 + PAD)                    # the declared width plus the UA padding
    expect(b[2]).to eq(300 - SPACING * 3 - (100 + PAD))   # everything left, content unmeasured
    # The text wraps to the column instead of the column growing to the text.
    lines = (text[cell_text] / 100).ceil
    expect(lines).to be > 1
    expect([a[3], b[3]]).to all(eq(line * lines + PAD))                         # Chrome: 56
    expect(t[3]).to eq(line * lines + PAD + SPACING * 2)
  end

  it 'treats a declared row height as a minimum every cell in it fills' do
    body = <<~HTML
      <table id="t"><tr id="r" style="height:80px"><td id="a">a</td>
      <td id="b" style="height:30px">b</td></tr></table>
    HTML
    boxes, = measure(body, ['#t', '#r', '#a', '#b'])
    t, r, a, b = boxes
    expect(r[3]).to eq(80)
    expect([a[3], b[3]]).to all(eq(80))              # the row wins over the cell's own 30px
    expect(t[3]).to eq(80 + SPACING * 2)
  end

  it 'keeps a cell as wide as its column and as tall as the row beside it' do
    body = '<table id="t"><tr><td id="empty"></td><td id="box"><div style="height:60px;width:40px"></div></td></tr></table>'
    boxes, = measure(body, ['#t', '#empty', '#box'])
    t, empty, box = boxes
    expect(empty[2]).to eq(PAD)                      # nothing in it but the UA padding
    expect(empty[3]).to eq(60 + PAD)                 # …yet as tall as the cell beside it
    expect(box[2]).to eq(40 + PAD)                   # a block child's width sizes the column
    expect(t[2]).to eq(PAD + (40 + PAD) + SPACING * 3)
  end

  # `display: table` + `display: table-cell` with nothing between them — the "table
  # for layout" idiom — is a table whose rows a browser generates for it. Without
  # them the table has no rows at all, and reported a 0x0 box for itself and every
  # cell in it.
  it 'generates the row a table-cell needs when the markup has none' do
    body = '<div id="t" style="display:table"><div id="a" style="display:table-cell">first cell</div>' \
           '<div id="b" style="display:table-cell">second</div></div>'
    boxes, text, line = measure(body, ['#t', '#a', '#b'], probes: ['first cell', 'second'])
    t, a, b = boxes
    # A CSS table has no UA border-spacing and its cells no UA padding — those are
    # `<table>` / `<td>` rules — so the cells sit flush against each other.
    expect(a[2]).to be_within(0.01).of(text['first cell'])
    expect(b[0]).to be_within(0.01).of(a[2])
    expect(t[2]).to be_within(0.01).of(text['first cell'] + text['second'])
    expect(t[3]).to eq(line)
  end

  # A `colspan` wider than the table is clamped to the columns that exist rather than
  # inventing them — Chrome gives the first table two columns and the second one.
  it 'clamps a colspan to the columns the table actually has' do
    wide = '<table id="t"><tr><td id="s" colspan="5">spanning wide text</td></tr>' \
           '<tr><td id="x">x</td><td id="y">y</td></tr></table>'
    boxes, text = measure(wide, ['#t', '#s', '#x', '#y'], probes: ['spanning wide text'])
    t, s, x, y = boxes
    each = (text['spanning wide text'] + PAD - SPACING) / 2
    expect([x[2], y[2]]).to all(be_within(0.01).of(each))
    expect(t[2]).to be_within(0.01).of(each * 2 + SPACING * 3)   # 3 gaps, not 6

    lone = '<table id="t2"><tr><td id="c" colspan="3">only row spans three</td></tr></table>'
    t2, c = measure(lone, ['#t2', '#c'], probes: ['only row spans three']).first
    expect(t2[2]).to be_within(0.01).of(c[2] + SPACING * 2)      # ONE column, so two gaps
  end

  it 'keeps a rowspan inside its own row group' do
    body = <<~HTML
      <table id="t"><tbody><tr><td id="s" rowspan="2">span</td><td id="one">one</td></tr></tbody>
      <tbody><tr><td id="two">two</td></tr></tbody></table>
    HTML
    boxes, _text, line = measure(body, ['#t', '#s', '#one', '#two'])
    _t, s, one, two = boxes
    expect(s[3]).to eq(line + PAD)          # one row tall: it cannot reach the next tbody
    expect(s[0]).to eq(SPACING)             # …so the next group's row starts at the FIRST
    expect(two[0]).to eq(SPACING)           # column, where the span would otherwise sit
    expect(one[0]).to be > two[0]
  end

  # Chrome renders a header group first and a footer group last whatever the source
  # order says. Getting this wrong also mis-picks the first row for fixed layout.
  it 'renders a footer group last however the markup orders it' do
    body = <<~HTML
      <table id="t"><tfoot id="foot"><tr><td>foot</td></tr></tfoot>
      <tbody id="body"><tr><td>body</td></tr></tbody></table>
    HTML
    _t, foot, body_group = measure(body, ['#t', '#foot', '#body']).first
    expect(body_group[1]).to be < foot[1]
  end

  it 'shares a declared table height out over its rows' do
    body = '<table id="t" style="height:200px"><tr><td id="a">A</td></tr><tr><td id="b">B</td></tr></table>'
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    expect(t[3]).to eq(200)
    expect([a[3], b[3]]).to all(eq((200 - SPACING * 3) / 2))     # Chrome: 97 each
    expect(b[1]).to eq(a[1] + a[3] + SPACING)
  end

  # A table told to be narrower than its content grows instead of letting its own
  # cells overflow the box that is supposed to contain them.
  it 'grows past a declared width too narrow for its content' do
    body = '<table id="t" style="width:200px"><tr><td id="a"><div style="width:400px;height:10px"></div></td></tr></table>'
    t, a = measure(body, ['#t', '#a']).first
    expect(a[2]).to eq(400 + PAD)
    expect(t[2]).to eq(400 + PAD + SPACING * 2)                  # Chrome: 406
  end

  # A percentage column resolves against the width being SHARED OUT, not the table's
  # own box — and takes no part in the surplus, which its auto neighbour absorbs.
  it 'resolves a percentage column against the assignable width' do
    body = '<table id="t" style="width:400px"><tr><td id="a" style="width:25%">A</td><td id="b">B</td></tr></table>'
    t, a, b = measure(body, ['#t', '#a', '#b']).first
    assignable = 400 - SPACING * 3
    expect(t[2]).to eq(400)
    expect(a[2]).to be_within(0.01).of(assignable * 0.25)        # Chrome: 98.5
    expect(b[2]).to be_within(0.01).of(assignable * 0.75)        # Chrome: 295.5
  end

  it 'puts a caption below the rows when caption-side says so' do
    body = '<table id="t" style="caption-side:bottom"><caption id="cap">cap</caption><tr><td id="a">A</td></tr></table>'
    t, cap, a = measure(body, ['#t', '#cap', '#a']).first
    expect(a[1]).to be < cap[1]
    expect(cap[1] + cap[3]).to eq(t[1] + t[3])
  end

  # A `<col span>` width is the width of EACH column it covers, not a total to split.
  it 'gives every column a col span covers the width it names' do
    body = <<~HTML
      <table id="t" style="table-layout:fixed;width:400px"><colgroup><col span="2" style="width:120px"><col></colgroup>
      <tr><td id="a">a</td><td id="b">b</td><td id="c">c</td></tr></table>
    HTML
    _t, a, b, c = measure(body, ['#t', '#a', '#b', '#c']).first
    expect([a[2], b[2]]).to all(eq(120))
    expect(c[2]).to eq(400 - SPACING * 4 - 240)                  # Chrome: 152
  end

  # The UA stylesheet is an origin above the initial value, so it has to answer a
  # resolved-value read too — and with the SAME number layout used, or the page and
  # the geometry disagree about a box that both of them are describing.
  it 'reports the UA cell padding and border-spacing through getComputedStyle' do
    html = '<html><body><table id="t"><tr><td id="d">x</td><th id="h">y</th></tr></table></body></html>'
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    read = JSON.parse(session.evaluate_script(<<~JS))
      JSON.stringify({
        pad:      getComputedStyle(document.getElementById('d')).paddingTop,
        th_pad:   getComputedStyle(document.getElementById('h')).paddingLeft,
        spacing:  getComputedStyle(document.getElementById('t')).borderSpacing,
        collapse: getComputedStyle(document.getElementById('t')).borderCollapse,
        laid_out: document.getElementById('d').getBoundingClientRect().height -
                  document.getElementById('d').clientHeight
      })
    JS
    # Chrome reports all four of these for a bare table.
    expect(read.values_at('pad', 'th_pad', 'spacing', 'collapse')).to eq(['1px', '1px', '2px', 'separate'])
    expect(read['laid_out']).to eq(0)   # no borders, so the border box IS the padding box
  end

  it 'stacks two tables as blocks, each shrunk to its own content' do
    body = '<table id="one"><tr><td>first</td></tr></table><table id="two"><tr><td>second</td></tr></table>'
    boxes, text = measure(body, ['#one', '#two'], probes: %w[first second])
    one, two = boxes
    expect(one[2]).to be_within(0.01).of(text['first'] + PAD + SPACING * 2)     # Chrome: 31.78
    expect(two[2]).to be_within(0.01).of(text['second'] + PAD + SPACING * 2)    # Chrome: 57.59
    expect(two[1]).to eq(one[1] + one[3])
  end
end
