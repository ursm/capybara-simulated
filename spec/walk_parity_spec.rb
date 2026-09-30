# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The Rust walk (`walk.rs`) held against the JS one (CSIM_WALK_PARITY): after each layout pass of the page's own, the
# Rust walk builds the same pass from the style engine's values and native compares the two record by record. These
# pin the instrument itself — that it compares, that a shape it takes comes out the same, and that one it has not been
# taught is declined by name rather than compared wrong.
RSpec.describe 'walk parity' do
  around do |example|
    saved = ENV.values_at('CSIM_STYLO', 'CSIM_WALK_PARITY')
    ENV['CSIM_STYLO'] = '1'
    ENV['CSIM_WALK_PARITY'] = '1'
    example.run
  ensure
    ENV['CSIM_STYLO'], ENV['CSIM_WALK_PARITY'] = saved
  end

  def parity(body, css = '')
    html = <<~HTML
      <!DOCTYPE html><html><head><style>body { margin: 8px; font: 16px sans-serif } #{css}</style></head>
      <body>#{body}</body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')
    s.evaluate_script('__csimWalkParityStats()')
  end

  def expect_clean(stats)
    expect(stats['compared']).to be_positive
    expect(stats).to include('clean' => stats['compared'], 'shape' => 0)
    expect(stats['samples']).to eq([])
  end

  it 'builds the records the JS walk sends for blocks and their text' do
    expect_clean(parity(<<~HTML, '.box { padding: 4px 10px; border: 2px solid; margin: 12px auto; width: 300px } p { line-height: 1.5 }'))
      <div class="box">Some text that wraps across several lines in a box three hundred pixels wide.</div>
      <p>A paragraph</p>
      <pre>pre-
      formatted</pre>
      <div style="height: 0; margin-bottom: 20px"></div>
      <div style="overflow: hidden; min-height: 30px; text-align: center; text-indent: 12px">clip</div>
    HTML
  end

  # A border width computes to a length whatever the style (css-backgrounds-3): the style engine keeps the 7px of a
  # `none` side, and the box draws — and lays out — no border there.
  it 'lays out a none border as no border, whatever width it computes to' do
    expect_clean(parity('<div style="border-width: 7px; border-left-style: solid">x</div>'))
  end

  # A percentage travels as its pair, or as the program a comparison makes of it, for native to resolve at the basis
  # it has; the ROOT's is resolved against the viewport, which native is handed nothing for. The programs are compared
  # by what they come to: the two walks write the same value in different shapes.
  it 'builds percentages, calc() and comparisons as the pairs and programs the JS walk sends' do
    expect_clean(parity(<<~HTML, 'html { padding: 1% 2px }'))
      <div style="width: 50%; height: 30%; padding: 2% 1% 0 calc(10% - 5px); margin: 0 5% 0 auto">
        <div style="width: calc(100% - 2rem); max-width: min(80%, 400px); min-height: clamp(10px, 5%, 40px)">x</div>
        <div style="padding: max(10px, 2%) 0; margin-left: min(5%, 20px); text-indent: 10%">y</div>
      </div>
    HTML
  end

  # Inline content: text in each inline box's own font, the boxes' edges on OPEN / CLOSE runs and in the inline table
  # (a percentage one as its fraction), a `<br>` and a `<wbr>` as edgeless boxes of their own.
  it 'builds the runs and the inline table of text in inline boxes' do
    expect_clean(parity(<<~HTML, 'b { font-size: 20px } .edged { padding: 0 4px 0 2%; margin-right: 3px; border-left: 2px solid }'))
      <p>plain <b>bold <i>both</i></b> <span class="edged">edged</span> <span></span>
         a line<br>after a break, and a long<wbr>word <span style="white-space: pre-wrap">kept   spaces</span></p>
    HTML
  end

  # A relative box's shift, as a length or as the pairs native resolves; an out-of-flow box as its own record naming
  # its containing block — a positioned ancestor's record, or the viewport's rectangle — and its insets, at its place
  # in the flow, or as a marker among the lines of a block of text.
  it 'builds relative and out-of-flow boxes' do
    expect_clean(parity(<<~HTML))
      <div style="position: relative; left: 5px; top: -3px; margin: 0 auto; width: 300px">
        <div style="position: relative; right: 10%; bottom: 2px">shifted</div>
        <div style="position: absolute; top: 10%; left: calc(50% - 20px); width: 40px">in the box</div>
        <p>text <span style="position: absolute; right: 0; bottom: min(5%, 8px)">marker</span> and more</p>
      </div>
      <div style="position: fixed; inset: 0 auto auto 0; width: 20%">on the viewport</div>
    HTML
  end

  # Floats among blocks and among lines, a box with clearance, and a block holding both block-level boxes and inline
  # content, whose runs of inline content are anonymous blocks of lines — floats among them as markers.
  it 'builds floats, clearance and mixed blocks' do
    expect_clean(parity(<<~HTML))
      <div style="width: 300px">
        <div style="float: left; width: 50px; height: 20px"></div>
        text beside the float <span style="float: right">right</span> more text
        <div style="clear: left">cleared</div>
        after the block <b>bold</b>
        <div style="float: inline-end">end</div>
      </div>
    HTML
  end

  # An atomic inline is its own record subtree hung by its `vertical-align`; an inline box's alignment moves the text it
  # owns (a shift, or against the parent's font); an intrinsic-size keyword width rides the record.
  it 'builds atomic inlines, vertical-align and keyword widths' do
    expect_clean(parity(<<~HTML))
      <p>a <span style="display: inline-block; width: 40px; height: 10px"></span> b
         <span style="display: inline-block; vertical-align: middle">m</span> <span style="display: inline-block; vertical-align: top">t</span>
         x<sup>2</sup> H<sub>2</sub>O <span style="vertical-align: 5px">up <b>more</b></span> <span style="vertical-align: 50%">half</span>
         <span style="vertical-align: text-top; padding: 2px">tt</span></p>
      <div style="width: max-content">shrinks to its text</div>
      <div style="width: 200px"><div style="width: fit-content">fits</div></div>
    HTML
  end

  # An inline box holding a block is laid out as a block; a float taken back with its anonymous run is walked again
  # seeing only the floats before it; a mixed block with no indent writes none, whatever its alignment.
  it 'builds the review repros of round 2' do
    expect_clean(parity(<<~HTML))
      <my-el><div>block inside a custom element</div></my-el> <a href="#"><div>card</div></a>
      <div><span style="float: left; clear: left">f</span><p>x</p>text</div>
      <div dir="rtl" style="text-align: center">a<p>x</p>b</div>
    HTML
  end

  # A relative inline box moves its fragments and everything on them — an atomic, a float, an out-of-flow box's static
  # position — as a chain the boxes inside it add to; an out-of-flow box whose containing block is such an inline box
  # names it by its entry in the inline table.
  it 'builds relative inline chains and inline containing blocks' do
    expect_clean(parity(<<~HTML))
      <p>x <span style="position: relative; left: 10%; top: 2px">rel <b style="position: absolute; left: 0">abs</b>
         <span style="display: inline-block">ib</span> <i style="position: relative; right: min(5%, 4px)">in
         <span style="float: left">fl</span></i></span></p>
    HTML
  end

  # Round 3: `<nobr>` keeps its words on one line, a block-holding inline carries no shift down and is a transformed
  # box's containing block, and `-webkit-baseline-middle` puts a box's middle on the baseline.
  it 'builds the review repros of round 3' do
    expect_clean(parity(<<~HTML))
      <p>a <nobr>n b</nobr></p>
      <div><span style="vertical-align: 5px">aa<b>x</b><div>blk</div></span></div>
      <div><span style="transform: translateX(1px)"><div>b</div><i style="position: absolute; top: 0">o</i></span></div>
      <p>a <span style="vertical-align: -webkit-baseline-middle">b</span>
         <span style="display: inline-block; vertical-align: -webkit-baseline-middle">c</span></p>
    HTML
  end

  # A flex container carries its axes as codes, its gaps as pairs, and its items in `order` — each with its basis, its
  # stretch and its cross alignment — and places its out-of-flow children by its alignment; an inline-flex is an atomic.
  it 'builds flex containers and their items' do
    expect_clean(parity(<<~HTML))
      <div style="display: flex; gap: 10px 5%; justify-content: space-between; align-items: center">
        <div style="flex: 1 1 30%">a</div><div style="order: -1; flex-basis: 50px; margin-left: auto">b</div>
        <div style="align-self: flex-end; flex-grow: 2">c</div><span style="position: absolute; top: 0">abs</span>
      </div>
      <div style="display: flex; flex-direction: column-reverse; flex-wrap: wrap; align-content: space-around; direction: rtl; height: 200px">
        <p style="margin: 0">x</p><p style="margin: 0; align-self: self-start; width: 50px">y</p>
        <div style="display: flex"><b style="display: block">nested</b></div>
      </div>
      <p>text <span style="display: inline-flex; justify-content: right"><i style="display: block">i</i></span></p>
    HTML
  end

  # Round 4: a percentage `top` falls back to a length `bottom` where the height is indefinite, and an over-constrained
  # relative box drops the side its CONTAINING BLOCK's direction says.
  it 'builds the review repros of round 4' do
    expect_clean(parity(<<~HTML))
      <p>a <span style="position: relative; top: 10%; bottom: 5px">b</span></p>
      <div dir="rtl"><span dir="ltr" style="position: relative; left: 5px; right: 9px">rl</span></div>
      <div dir="rtl"><div dir="ltr" style="position: relative; left: 5px; right: 9px">block</div></div>
    HTML
  end

  # A replaced element or a control is a leaf of its intrinsic size — an image's decoded one (the arena holds it), a
  # frame's default, an svg's or a canvas's attributes, a button input's or a select's label measured in its font —
  # and a text-drawing control carries where its baseline sits; a `<button>` is a box of its content.
  it 'builds replaced elements and controls' do
    expect_clean(parity(<<~HTML))
      <p>text <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20"> <input value="x"> <input type="submit">
         <input type="checkbox"> <input type="button" value="Go
      now"> <select><option>one</option><option>a longer option</option><optgroup label="g"><option>x</option></optgroup></select>
         <textarea></textarea> <button>click <b>me</b></button></p>
      <div><img style="display: block"><svg width="40" viewBox="0 0 10 5"></svg><canvas width="50"></canvas>
        <iframe></iframe> <progress></progress> <meter></meter></div>
    HTML
  end

  # An image keeps the size it decoded when it is adopted into another realm's tree, whose arena the walk reads.
  it 'reads the decoded size of an image adopted from a frame' do
    gif = 'data:image/gif;base64,R0lGODlhAgADAIAAAP///wAAACH5BAEAAAAALAAAAAACAAMAAAICjF8AOw=='
    pages = {
      '/'  => '<!DOCTYPE html><html><body><iframe id="f" src="/f"></iframe><div id="host"></div></body></html>',
      '/f' => %(<!DOCTYPE html><html><body><img id="i" src="#{gif}"></body></html>)
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')
    s.evaluate_script('__csimWalkParityStats()')
    s.execute_script(<<~JS)
      const img = document.getElementById('f').contentDocument.getElementById('i');
      document.getElementById('host').appendChild(document.adoptNode(img));
    JS
    s.evaluate_script('document.body.offsetHeight')
    expect_clean(s.evaluate_script('__csimWalkParityStats()'))
  end

  # A LIST BOX is the control's box — its widest option and the list box's padding, a row per displayed row — with its
  # options stacked inside it as blocks where it has any, and a leaf of its own where it has none.
  it 'builds list boxes' do
    expect_clean(parity(<<~HTML))
      <p>a <select multiple><option>one</option><option>a longer one</option><optgroup label="g"><option>x</option></optgroup></select> b</p>
      <select size="3"></select>
      <div><select size="2" style="width: 100px; display: block"><option>q</option><option style="display: none">h</option></select></div>
    HTML
  end

  # A run of bare text in a flex container is an ANONYMOUS item of its own, a `<br>` in it a break.
  it 'builds anonymous flex items' do
    expect_clean(parity(<<~HTML))
      <div style="display: flex; align-items: center; text-align: center; direction: rtl">bare text <b>bold item</b> more <br> text</div>
      <div style="display: flex; flex-direction: column">   <span>x</span>   </div>
      <div align="right" style="display: flex">aligned by the attribute its container carries</div>
      <div style="display: flex"><wbr><div>after a lone wbr</div>a<wbr>b</div>
    HTML
  end

  # A table is its record, its columns' declarations on the grid stream, a record per row group and row (an anonymous
  # one around stray cells), its cells walked under their rows with their placement in the grid (an anonymous cell
  # around stray content), its captions and its out-of-flow children.
  it 'builds tables' do
    expect_clean(parity(<<~HTML))
      <table style="border-spacing: 4px 2px; width: 300px">
        <caption>top</caption>
        <colgroup><col style="width: 50px"><col span="2" style="width: 20%"></colgroup>
        <tfoot><tr><td colspan="3">foot</td></tr></tfoot>
        <thead><tr style="height: 30px"><th>a</th><th style="vertical-align: top">b</th><td rowspan="2">c</td></tr></thead>
        <tbody><tr><td style="width: 25%">d <b>bold</b></td><td><div style="height: 50%">pct</div></td></tr>
          <tr><td>e</td><td style="position: relative">f<span style="position: absolute">abs</span></td></tr></tbody>
        <tbody></tbody>
        <caption style="caption-side: bottom">bottom</caption>
      </table>
      <div style="display: table; table-layout: fixed; width: 200px">stray text<div style="display: table-cell">cell</div><p>block</p></div>
      <div style="display: table"><div style="display: table-row">x<div style="display: table-cell; vertical-align: middle">y</div></div></div>
      <p>inline <span style="display: inline-table"><span style="display: table-cell">t</span></span></p>
    HTML
  end

  # A table's attributes are declarations in both style systems: its frame and its cells' (none where the border is
  # zero), their padding, its float or centring, and a row's `valign` its cells inherit.
  it 'builds tables from their attributes' do
    expect_clean(parity(<<~HTML))
      <table border="0"><tr><td>a</td></tr></table>
      <table border="1" cellpadding="6" align="center"><tr valign="top"><td>b</td><td>c</td></tr></table>
      <table align="right" border="x"><tbody style="vertical-align: bottom"><tr><td>d</td></tr></tbody></table>
      <p>after</p>
    HTML
  end

  # A `border` written later frames the cells, or stops framing them, in the style engine too.
  it 'restyles the cells of a table whose border is written' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<table id="t" border="2"><tbody><tr><td>a</td><td>b</td></tr></tbody></table>']] })
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')
    s.evaluate_script('__csimWalkParityStats()')
    ['removeAttribute("border")', 'setAttribute("border", "0")', 'setAttribute("border", "1")', 'setAttribute("border", "0")'].each do |write|
      s.execute_script(%(document.getElementById("t").#{write}))
      s.evaluate_script('document.body.offsetHeight')
      expect_clean(s.evaluate_script('__csimWalkParityStats()'))
    end
  end

  # A COLLAPSING table resolves every edge of its grid to the widest border meeting on it — cells, rows, groups,
  # columns and its own, a `hidden` one suppressing it — and each box sharing an edge keeps half; the table's own
  # border is the outer half at its rim, with no padding and no spacing. Columns mirror in an rtl table.
  it 'builds collapsing tables' do
    expect_clean(parity(<<~HTML))
      <table style="border-collapse: collapse; border: 4px solid; padding: 9px">
        <tr><td style="border: 2px solid">a</td><td style="border-left: 6px solid; border-right: hidden">b</td></tr>
        <tr><td colspan="2" style="border: 1px solid">c</td></tr></table>
      <table style="border-collapse: collapse" dir="rtl"><colgroup style="border: 1px solid"><col style="border-left: 3px solid"><col></colgroup>
        <tbody style="border-top: 5px solid"><tr style="border-bottom: 7px solid"><td>x</td><td rowspan="2">y</td></tr><tr><td>z</td></tr></tbody></table>
      <table style="border-collapse: collapse; border: 2px solid">stray<tr><td>q</td></tr></table>
      <table border="1" rules="all" frame="void"><tr><td>r</td><td>s</td></tr></table>
    HTML
  end

  # GENERATED CONTENT: an element's `::before` / `::after` box — the node the JS side registered for it — is its first /
  # last child, holding the text the style engine's `content` makes: strings, `attr()`, the quote marks, nothing for a
  # counter nor for the alternative text; as an inline, a block, a float, an out-of-flow box, a flex item, in a table.
  it 'builds generated content' do
    expect_clean(parity(<<~HTML, <<~'CSS'))
      <p class="a" data-x="attr!">text</p><div class="b">x</div><span class="q">q</span>
      <div class="f">item</div><table class="t"><tr><td>c</td></tr></table><p class="fl">text beside</p>
      <div class="ab" style="position: relative">abs</div><p class="e">e</p><p class="n">n</p><ol><li class="cn">c</li></ol>
      <span class="ib">ib</span><p class="none">z</p>
    HTML
      .a::before { content: "Hi " } .a::after { content: attr(data-x) "!" / "alt" }
      .b::before { content: "blk"; display: block } .q::before { content: open-quote } .q::after { content: close-quote }
      .f { display: flex } .f::before { content: "B" } .f::after { content: "A"; flex: 1 } .t::before { content: "tb" }
      .fl::before { content: "F"; float: left; width: 20px } .ab::after { content: "X"; position: absolute; right: 0 }
      .e::before { content: "" } .n::before { content: "\f00c\A x"; white-space: pre }
      .cn::before { content: counter(list-item) ". " } .ib::before { content: "I"; display: inline-block; padding: 3px }
      .none::before { content: "hidden"; display: none }
    CSS
  end

  # A `<q>` quotes itself (HTML's sheet), an `attr()` falls back to its string where the attribute is missing, and a
  # `<progress>` / `<meter>` generates nothing.
  it 'builds the review repros of round 10' do
    expect_clean(parity(<<~HTML, <<~'CSS'))
      <p><q>a <q>b</q></q> <span class="x">y</span> <span class="x" data-m="v">z</span></p><progress></progress><meter></meter>
    HTML
      .x::after { content: attr(data-m, "fb") } progress::before, meter::before { content: "no" }
    CSS
  end

  # A pass whose runs need several faces names every one of them at once, and is compared.
  it 'resolves every face a pass needs' do
    expect_clean(parity(<<~HTML))
      <p style="font-weight: 599">a</p><p style="font-weight: 600">b</p><p style="font-style: oblique 10deg">c</p>
      <p style="font-style: italic; font-weight: bolder">d</p><p style="font-family: serif">e</p>
    HTML
  end

  # A GRID container carries its gaps, its column template — an auto repeat left as one copy for native to count — its
  # auto rows' height, each track's base and limit, and each item's declared column lines on the grid stream; its items
  # (an anonymous one around bare text) are records of their own, an auto one imposed its row.
  it 'builds grid containers' do
    expect_clean(parity(<<~HTML, <<~'CSS'))
      <div class="g1"><div>a</div><div>b</div><div>c</div></div>
      <div class="g2">text <b>x</b> more<div style="grid-column: 1 / -1">full</div></div>
      <div class="g3"><div>1</div><div>2</div><div>3</div><div>4</div></div><span style="display: inline-grid">ig</span>
      <div class="g4"><div style="grid-column: span 2">s</div><div style="grid-column-start: 3">t</div><p>u</p><span style="position: absolute">o</span></div>
    HTML
      .g1 { display: grid; grid-template-columns: 100px 1fr 20%; gap: 10px 5% }
      .g2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 40px }
      .g3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)) fit-content(50px); column-gap: 1em }
      .g4 { display: grid; grid-template-columns: min-content max-content auto fit-content(20%) calc(10% + 5px);
            grid-auto-rows: minmax(30px, auto); position: relative }
    CSS
  end

  # Round 11: a `grid-auto-rows` in any unit is the auto rows' height, and a span to a NAMED line counts none.
  it 'builds the review repros of round 11' do
    expect_clean(parity(<<~HTML))
      <div style="display: grid; grid-template-columns: [a] 50px [b] 50px [c] 50px; grid-auto-rows: 2em">
        <div>a</div><div>bb</div><div style="grid-column: span b">sn</div></div>
    HTML
  end

  # A VERTICAL writing mode: its block axis the horizontal one (a block's auto width is its content's), its UA margins
  # flow-relative, a flex container's axes its flow's, and a line's alignment never from the right.
  it 'builds vertical writing modes' do
    expect_clean(parity(<<~HTML))
      <div style="writing-mode: vertical-rl; height: 200px"><p>text in a vertical block</p><div style="width: 50px">w</div></div>
      <div style="writing-mode: vertical-lr; display: flex; height: 100px"><span>a</span><span>b</span></div>
      <div style="display: flex; flex-direction: column; writing-mode: vertical-rl; direction: rtl"><i>x</i><i>y</i></div>
      <p style="writing-mode: vertical-rl; text-align: end">al</p><blockquote style="writing-mode: vertical-lr">q</blockquote>
    HTML
  end

  # A box-less `display: contents` element is replaced by its children, in its place, in every enumeration — a block's
  # lines and blocks, a flex or grid container's items (each a formatting context of its own), a table's rows — and a
  # run spliced out of one still draws with its font and collapses by its `white-space`; its edges and its
  # `vertical-align` are nothing.
  it 'builds through display: contents' do
    expect_clean(parity(<<~HTML, '.ps::before { content: "gen"; display: block }'))
      <p>a <span style="display: contents; font-size: 24px">big <b>bold</b></span> c</p>
      <div><div style="display: contents"><div>block1</div>text<div>block2</div></div></div>
      <div style="display: flex"><div style="display: contents"><div>i1</div><div>i2</div></div></div>
      <div style="display: grid; grid-template-columns: 1fr 1fr"><span style="display: contents"><i>g1</i><i>g2</i></span></div>
      <table><tr style="display: contents"><td>x</td></tr></table>
      <p style="width: 80px"><span style="display: contents; white-space: nowrap">no wrap here at all</span></p>
      <div class="ps" style="display: contents"></div>
      <div><span style="display: contents; padding: 20px; vertical-align: 10px">pad</span></div>
    HTML
  end

  # A SHADOW TREE is walked in the flat tree: a host's children are its shadow root's, a slot's its assigned nodes (its
  # own fallback where none are assigned), and a slot — `display: contents` in the UA sheet — is replaced by them.
  it 'builds shadow trees through their slots' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] })
      <!DOCTYPE html><body><div id="h"><span>light a</span><b slot="s">named</b> tail</div><p id="h2">x</p><script>
        const r = document.getElementById('h').attachShadow({mode: 'open'});
        r.innerHTML = '<style>p { margin: 4px; font-size: 20px }</style><p>before <slot name="s"></slot> after</p>' +
                      '<div><slot>fallback</slot></div><slot name="none">fb text</slot>';
        document.getElementById('h2').attachShadow({mode: 'open'}).innerHTML = '<div style="display: flex"><slot></slot><i>y</i></div>';
      </script></body>
    HTML
    s.visit '/'
    s.evaluate_script('document.body.offsetHeight')
    expect_clean(s.evaluate_script('__csimWalkParityStats()'))
  end

  it 'declines by name what it has not been taught' do
    stats = parity('<div style="display: -webkit-box">x</div>')
    expect(stats['compared']).to eq(0)
    expect(stats['declined']).to include('-webkit-box' => be_positive)
  end
end
