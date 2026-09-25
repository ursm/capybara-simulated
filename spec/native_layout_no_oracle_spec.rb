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
    # (a RELATIVE offset inside a non-linear math function still resolves against the oracle's basis — a plain or a
    # linear percentage one is native's since 2026-09-24 — and a cell native cannot measure still asks the oracle's
    # intrinsic widths; a plain percentage width no longer reads anything, and neither does an intrinsic SIZE,
    # which is data off the DOM rather than a layout the oracle ran)
    s = session_with('<div style="width:300px"><p style="position:relative;left:max(10%, 5px)">hello</p>' \
                     "<table><tr><td>a #{WalkRefusals::POSITIONED}</td></tr></table></div>")
    reads = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true}).oracleReads')
    expect(reads.keys).to include('recordCbW _lbCbW')
    expect(reads.keys).to include('nlShadowRun the pass root origin and width (handed over)')
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
  # children. Their walk and native pass read NOTHING of the oracle's but what the harness hands the pass root
  # (its origin and width) — the first shapes the oracle could be deleted for, so a read creeping back into a common
  # path fails here rather than hiding among the thousands every other shape still makes.
  it 'lays out plain shapes without reading the oracle' do
    [
      '<div style="width:300px"><p style="margin:10px">hello world</p><div style="height:20px"></div></div>',
      '<div style="width:400px"><div style="width:50%;padding:5% 2%;margin:0 auto">centred</div></div>',
      '<div style="display:flex;width:300px;gap:10px"><div style="flex:1">a</div><div style="width:30%">b c d</div></div>',
      '<div style="width:300px;height:200px"><div style="height:50%;max-width:80%">half</div></div>',
      # …and a comparison function over one affine operand, which travels as its clamped pair — `clamp()`'s MINIMUM
      # winning where its bounds cross, as CSS has it (100 here, not 50)
      '<div style="width:300px;height:200px"><div style="width:min(50%, 60px);height:max(20%, 10px)">x</div><div style="width:clamp(100px, 10%, 50px)">y</div></div>',
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
      # …and a line counted from the END under that repeat: which column it names depends on how many copies
      # native made, so answering it without the oracle is the whole of this increment
      '<div style="width:400px"><div style="display:grid;grid-template-columns:40px repeat(auto-fill, 60px) 20px;gap:5px"><div style="grid-column-start:-2">a</div><div style="grid-column:2 / span 3">b</div></div></div>',
      # …and a LIST BOX, whose own box native derives from the control's intrinsic data and whose rows it stacks
      '<div style="width:400px">t <span style="display:inline-block"><select multiple size="3" style="display:block;width:120px"><option>a</option><option>bbbb</option></select></span> u</div>'
    ].each do |body|
      r = session_with(body).evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
      expect(r['oracleReads'].keys).to eq(['nlShadowRun the pass root origin and width (handed over)']), body
    end
  end
end
