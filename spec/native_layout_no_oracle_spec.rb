# frozen_string_literal: true

# `__csimLayoutShadowRun(root, {noOracle: true})` is the instrument the oracle's REMOVAL is measured with: the
# walk and the native pass run with every oracle layout stamp hidden behind a trap, so a shape either comes out
# right without the oracle's figures or shows which of them it needed. An instrument that leaks the stamps,
# fails to restore them, or fails to hide them would report removal progress that is not there — so these pin
# the instrument itself, not any layout rule.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/shadow_parity'
require_relative 'support/walk_refusals'

RSpec.describe 'native layout no-oracle run', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def session_with(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    session = simulated_session(Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app)
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session
  end

  it 'leaves every layout property exactly as it found it' do
    # Every own `_lb…` property, memos included: the run recomputes memos from poisoned bases (`#b`'s percentage
    # padding against a hidden containing-block width), and one that outlived the run would hand NaN edges to the
    # next geometry read.
    s = session_with('<div id="a" style="width:300px"><div id="b" style="width:50%;padding:5%">x</div></div>')
    snapshot = <<~JS
      JSON.stringify(['a', 'b'].map(id => {
        const el = document.getElementById(id);
        return Object.getOwnPropertyNames(el).filter(k => k.startsWith('_lb')).sort().map(k => {
          const d = Object.getOwnPropertyDescriptor(el, k);
          return [k, 'value' in d, JSON.stringify(d.value)];
        });
      }))
    JS
    s.evaluate_script("(() => { globalThis.__keep = document.getElementById('b')._lb; return true; })()")
    rect = "JSON.stringify(document.getElementById('b').getBoundingClientRect())"
    rect_before = s.evaluate_script(rect)
    before = s.evaluate_script(snapshot)   # …after the geometry read, which leaves memos of its own
    expect(JSON.parse(before).last.map(&:first)).to include('_lb', '_lbEdge', '_lbEdgePass')

    r = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
    # …and nothing wrote a result while hidden: a write means the oracle's layout ran inside the trap and its
    # answers were served back to the walk as its own
    expect(r).to include('ok' => true, 'oracleWrites' => 0)
    expect(s.evaluate_script(snapshot)).to eq(before)
    # …the very same box object, not a copy
    expect(s.evaluate_script("globalThis.__keep === document.getElementById('b')._lb")).to be(true)
    # …and what reads geometry afterwards still sees the oracle's answers
    expect(s.evaluate_script(rect)).to eq(rect_before)
    expect(s.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0)
  end

  it 'records where the walk read an oracle stamp' do
    # (a VERTICAL table's cell width with a percentage still resolves against the oracle's basis — a relative offset
    # did until every comparison became a program, 2026-09-26 — and a cell native cannot measure still asks the oracle's
    # intrinsic widths; a plain percentage width no longer reads anything, and neither does an intrinsic SIZE, which is
    # data off the DOM rather than a layout the oracle ran)
    s = session_with('<div style="width:300px"><table style="writing-mode:vertical-rl;height:200px"><tr><td style="width:calc(40% + 10px)">hello</td></tr></table>' \
                     "<table><tr><td>a #{WalkRefusals::POSITIONED}</td></tr></table></div>")
    reads = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true}).oracleReads')
    expect(reads.keys).to include('recordCbW _lbCbW')
    # …a helper under the walk site that called it, not under its own name
    helpers = reads.keys.grep(/ helper:/)
    expect(helpers).not_to be_empty
    expect(helpers).not_to include(a_string_matching(/\A(\w+) helper:\1\z/))
    expect(reads.values).to all(be > 0)
  end

  it 'really hides the stamps from the walk' do
    # A shape that comes out WRONG without the oracle's figures today: an inline-TABLE, which native does not lay
    # out, is pushed onto its line with the oracle's box and its last line's baseline. A trap that let those
    # through would report it right — so this is the check that the instrument can fail at all, and revealing
    # the stamps it reads is the A/B that pins the break on them rather than on the trap's mere presence. When
    # native lays the shape out itself it stops breaking; swap in another BREAK from a `CSIM_SWEEP_NO_ORACLE=1`
    # sweep rather than deleting the example.
    s = session_with(%(<div style="width:400px">text #{WalkRefusals::POSITIONED} after</div>))
    run = ->(opts) { s.evaluate_script("globalThis.__csimLayoutShadowRun(undefined, #{opts})") }
    expect(run.('undefined')).to include('ok' => true, 'mismatches' => 0)

    hidden = run.('{noOracle: true}')
    expect(hidden).to include('ok' => true, 'oracleWrites' => 0)
    expect(hidden['mismatches']).to be > 0
    expect(hidden['oracleReads'].keys).to include('nlGatherRuns _lb.width', 'boxBaselineOffset _lbLastLineY')

    read = "['_lb', '_lbLastLineY', '_lbLastLineAsc', '_lbLastLineOrder', '_lbOrder']"
    revealed = run.("{noOracle: true, reveal: #{read}}")
    expect(revealed).to include('ok' => true, 'mismatches' => 0)
    expect(revealed['oracleReads'].keys).not_to include(a_string_matching(/ _lb(\.|$)/))
    # …the box alone is not enough: the baseline it hangs from is a stamp of its own
    expect(run.("{noOracle: true, reveal: ['_lb']}")['mismatches']).to eq(hidden['mismatches'])
  end

  it 'computes a memo again rather than serving the oracle its answer' do
    # A memo the oracle's pass left fresh is an oracle answer no trap sees: the helper behind it is never entered,
    # so it is never noted. A grid column sized over an item holding a PUSHED atomic asks the oracle's intrinsic
    # widths, memoised on the item — served, the walk's dependency on that machinery vanished from the record.
    s = session_with(%(<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a #{WalkRefusals::POSITIONED}</div><div>x</div></div>))
    r = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
    expect(r).to include('ok' => true, 'oracleWrites' => 0)
    expect(r['oracleReads'].keys).to include('gridColumnContent helper:intrinsicWidths')
  end

  it 'reads the oracle\'s content width only where a track side is RESOLVED against it' do
    # The resolved-px fallback — a grid holding content native cannot measure — sizes every track against the
    # oracle's per-column contributions, which are the oracle's OWN column list at the oracle's OWN width. That
    # is the one read the grid encode still makes.
    s = session_with(%(<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a #{WalkRefusals::POSITIONED}</div><div>x</div></div>))
    expect(s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')['oracleReads'].keys)
      .to include('oracleContentW _lb.width')
  end

  it 'gives back the ordinary answer with every stamp revealed' do
    # The run differs from an ordinary one in more than the traps — every memo is computed again, in the walk's
    # order rather than the oracle's — so revealing everything must still come out clean, or a BREAK could be
    # the instrument's own doing.
    [
      '<div style="width:300px"><div style="padding:5%">x</div></div>',
      '<div style="display:flex;width:200px"><span style="flex:1">a b c</span><img width="20" height="30"></div>',
      '<table style="border-collapse:collapse"><tr><td style="border:3px solid">a</td><td>b c</td></tr></table>',
      '<p>one <b style="display:inline-block;width:40%">two</b> <span style="position:relative;top:4px">three</span></p>'
    ].each do |body|
      s = session_with(body)
      expect(s.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => true, 'mismatches' => 0)
      revealed = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true, reveal: true})')
      expect(revealed).to include('ok' => true, 'mismatches' => 0), body
    end
  end

  # The shapes the port has already freed: block flow, text, a flex row, percentage sizes and edges on in-flow
  # children. Their walk and native pass read NOTHING of the oracle's — the first shapes the oracle could be deleted
  # for, so a read creeping back into a common path fails here rather than hiding among the thousands every other
  # shape still makes.
  it 'lays out plain shapes without reading the oracle' do
    [
      '<div style="width:300px"><p style="margin:10px">hello world</p><div style="height:20px"></div></div>',
      '<div style="width:400px"><div style="width:50%;padding:5% 2%;margin:0 auto">centred</div></div>',
      '<div style="display:flex;width:300px;gap:10px"><div style="flex:1">a</div><div style="width:30%">b c d</div></div>',
      # …its items' percentage EDGES among them, whose auto margins are all the walk reads of them
      '<div style="display:flex;width:400px"><div style="padding:0 5%;margin-left:2%">a</div><div style="flex:1;padding-top:3%">b</div></div>',
      '<div style="width:300px;height:200px"><div style="height:50%;max-width:80%">half</div></div>',
      # …a MARGIN and a PADDING written as such functions too, a bare calc-sum argument and a padding's 0 floor included
      '<div style="width:300px"><div style="margin-top:max(10%, 12px);padding:clamp(4px, 5%, 30px) clamp(0px, 10% - 20px, 40px);border:2px solid">x</div></div>',
      # …and a comparison function over affine operands, which travels as its program — `clamp()`'s MINIMUM winning where
      # its bounds cross, as CSS has it (100 here, not 50), two lines that cross beside a constant, and a nested one
      '<div style="width:300px;height:200px"><div style="width:min(50%, 60px);height:max(20%, 10px)">x</div><div style="width:clamp(100px, 10%, 50px)">y</div></div>',
      '<div style="width:300px;height:200px"><div style="width:min(50%, calc(10% + 40px), 90px);height:max(0px, min(40%, calc(100px - 20%)))">x</div></div>',
      # …a percentage height that resolves to AUTO, whose bottom margin then adjoins its last child's — native's call
      '<div style="width:300px"><div style="height:50%"><p style="margin:0 0 12px">x</p></div><div style="height:5px"></div></div>',
      # …an OUT-OF-FLOW box against a positioned block and against the viewport, percentages and all, and a relative
      # box with length insets
      '<div style="position:relative;width:300px;height:200px;border:5px solid"><div style="position:absolute;left:10%;top:20%;width:30%;height:25%;padding:0 5%">abs</div></div>',
      '<div style="width:300px;height:200px"><div style="position:absolute;left:5%;right:5%;top:0;bottom:10%">viewport</div></div>',
      # …and against a containing block with PERCENTAGE padding, whose padding box is its border box less its borders
      '<div style="position:relative;width:300px;padding:5% 2%;border:3px solid"><div style="position:absolute;left:10%;width:50%;top:0">abs</div><p>x</p></div>',
      '<div style="position:relative;left:4px;top:-3px;width:300px"><div style="position:absolute;inset:10%">rel</div><p>x</p></div>',
      # …and against a relatively positioned INLINE, from the fragments native lays it out as — wrapping, offset by
      # lengths, and resolving the box's percentages
      '<div style="width:90px">aaaa <span style="position:relative;left:3px;border:2px solid">bb cc dd ee<i style="position:absolute;top:1px;left:2px;right:3px;bottom:4px"></i></span> ff</div>',
      '<div style="width:220px">aaaa <span style="position:relative;padding-left:6px">bb <i style="position:absolute;width:50%;height:50%;top:10%;left:25%"></i>cc</span> dd</div>',
      # …and tables: auto and fixed layout, a caption, a span, a percentage column
      '<table style="border-spacing:2px"><caption style="width:150%">cap</caption><tr><td>a</td><td style="width:30%">b c</td></tr><tr><td colspan="2">d</td></tr></table>',
      '<table style="table-layout:fixed;width:50%;border-collapse:collapse"><tr><td style="border:2px solid">a</td><td>b</td></tr></table>',
      # …whose gate asks whether a height is imposed on the table without asking the oracle's box
      '<table style="border-spacing:2px"><tr><td><div style="height:50%">x</div></td></tr></table>',
      # …and a GRID asked for its own intrinsic width: the track list, the column contributions and the §12.7
      # `fr` expansion are native's, so nothing asks what the oracle laid the grid out as
      '<div style="width:max-content"><div style="display:grid;grid-template-columns:40px 1fr"><span>aa bb</span><div>cc</div></div></div>',
      '<div style="width:400px"><div style="float:left"><div style="display:grid;grid-template-columns:min-content auto;gap:6px"><div>aa bb</div><div>cc dd</div></div></div></div>',
      # …an `auto-fill` repeat included: how many copies fit is native's own count against its own content box,
      # and an intrinsic measure — which has no width to fit against — makes the one copy §7.2.3.2 gives it
      '<div style="width:max-content"><div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(50px, 1fr));gap:10px"><div>bb cc</div><div>dd</div></div></div>',
      '<div style="width:400px"><div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(80px, 1fr));gap:4px"><div>a</div><div>b</div><div style="grid-column:1 / -1">wide</div></div></div>',
      # …an item a declared ROW height sizes, whose own vertical edges are lengths: no basis is asked for them
      '<div style="width:300px"><div style="display:grid;grid-template-columns:50% 50%;grid-auto-rows:30px"><div style="padding:3px">q</div><div>r</div></div></div>',
      # …a flex item's PERCENTAGE height, which never stretches whether it resolves (a definite row) or not (an
      # indefinite one), a grid item's under a declared row, and a CELL's, which a table lays out against no basis
      '<div style="display:flex;width:300px"><div style="height:50%">x</div><div style="height:40px">y</div></div>',
      '<div style="display:flex;width:300px;height:150px"><div style="height:50%"><div style="height:50%;width:50%">n</div></div><div style="width:20px;height:20px"></div></div>',
      '<div style="width:300px"><div style="display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:60px"><div style="height:50%">g</div><div>h</div></div></div>',
      '<table style="height:200px;border-spacing:0"><tr><td style="height:50%;min-height:30px">ab cd</td><td>zz</td></tr></table>',
      # …a table CELL's percentage padding, against the table's content box once its columns have grown it
      '<div style="width:300px"><table><tr><td style="padding:0 10%">aa bb</td><td>cc</td></tr></table></div>',
      '<div style="width:300px"><div style="float:left"><table style="width:80%"><tr><td style="padding:0 8%;box-sizing:border-box;width:60px">aa bb</td><td>cc</td></tr></table></div>beside</div>',
      # …a flex-item table's relative CAPTION, whose percentage offset resolves against the table's own height
      '<div style="display:flex;width:300px;height:150px"><table style="width:200px;min-height:120px"><caption style="position:relative;top:10%">cap</caption><tr><td style="height:40px">d</td></tr></table><div>y</div></div>',
      # …and whose vertical edges are PERCENTAGES of its track: native imposes the row once it has that track
      '<div style="width:300px"><div style="display:grid;grid-template-columns:100px 1fr;grid-auto-rows:40px"><div style="padding:10% 0">aa<div>blk</div></div><div>z</div></div></div>',
      # …and a line counted from the END under that repeat: which column it names depends on how many copies
      # native made, so answering it without the oracle is the whole of this increment
      '<div style="width:400px"><div style="display:grid;grid-template-columns:40px repeat(auto-fill, 60px) 20px;gap:5px"><div style="grid-column-start:-2">a</div><div style="grid-column:2 / span 3">b</div></div></div>',
      # …an atomic's percentage WIDTH inside an inline that holds a block — an atomic itself, whose anonymous group
      # the box hangs under — including in a flex item native measures
      '<div style="width:300px"><b><div>blk</div><i>x <span style="display:inline-block;width:30%">a</span></i></b> words here</div>',
      '<div style="display:flex;flex-direction:column;align-items:flex-start;width:300px"><div><b><div>blk</div><i>x <span style="display:inline-block;width:30%">a</span></i></b> words here</div></div>',
      # …and a percentage HEIGHT under a mixed block's anonymous group, against the block's own basis
      '<div style="width:300px;height:100px">text <b><span style="display:inline-block;height:50%;width:10px"></span></b> more<div>block</div></div>',
      # …and a LIST BOX, whose own box native derives from the control's intrinsic data and whose rows it stacks
      '<div style="width:400px">t <span style="display:inline-block"><select multiple size="3" style="display:block;width:120px"><option>a</option><option>bbbb</option></select></span> u</div>'
    ].each do |body|
      r = session_with(body).evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
      expect(r['oracleReads'].to_h).to be_empty, body
    end
  end

  # …the `<body>` pass root among them, which native places ITSELF as the oracle's document layout does: against
  # the initial containing block — the root element's declared width, else the viewport's — at its leading margin,
  # an `auto` pair splitting what its width leaves in the ROOT element's direction, and at its top margin collapsed
  # with its first child's. Until 2026-09-26 every run read the oracle's box for it ("the pass root origin and width
  # (handed over)"), the one read every shape made. Chrome's figures; a pass rooted anywhere else — an incremental
  # relayout's subtree — is still handed its origin, and says so.
  it 'places the body pass root itself' do
    div = '<div id="m">x</div>'
    {
      ['body{margin:0 auto !important;max-width:200px}', div]                        => [412, 0, 200],
      ['html{direction:rtl}body{margin:0 10px 0 30px !important;width:300px}', div] => [714, 0, 300],
      ['html{direction:rtl}body{margin:0 auto 0 0 !important;width:300px}', div]    => [0, 0, 300],
      ['html{width:500px}body{margin:0 auto !important;width:300px}', div]          => [100, 0, 300],
      ['body{margin:0 5% !important}', div]                                         => [51.188, 0, 921.625],
      ['body{margin:5px !important}', '<p id="m" style="margin:30px 0">a</p>']        => [5, 30, 1014]
    }.each do |(css, child), (x, y, w)|
      s = session_with("<style>#{css}</style>#{child}")
      r = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      expect(r).to include('ok' => true, 'mismatches' => 0), "#{css}: #{r.inspect}"
      expect(r['oracleReads'].to_h).to be_empty, css
      rect = s.evaluate_script("(r => [r.x, r.y, r.width])(document.getElementById('m').getBoundingClientRect())")
      expect(rect).to match([be_within(0.05).of(x), eq(y), be_within(0.05).of(w)]), css   # (Chrome's LayoutUnits)
    end
    # …and a subtree root is handed its origin, the one read left
    s = session_with('<div id="m" style="width:300px"><p>x</p></div>')
    r = s.evaluate_script("globalThis.__csimLayoutShadowRun(document.getElementById('m'), {noOracle: true})")
    expect(r['oracleReads'].to_h.keys).to eq(['nlShadowRun the pass root origin and width (handed over)'])
  end
end
