# frozen_string_literal: true

# `__csimLayoutShadowRun(root, {noOracle: true})` is the instrument the oracle's REMOVAL is measured with: the
# walk and the native pass run with every oracle layout stamp hidden behind a trap, so a shape either comes out
# right without the oracle's figures or shows which of them it needed. An instrument that leaks the stamps,
# fails to restore them, or fails to hide them would report removal progress that is not there — so these pin
# the instrument itself, not any layout rule.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

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
    s = session_with('<div style="width:300px"><p style="width:50%">hello</p></div>')
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
    # A shape that comes out WRONG without the oracle's figures today: a vertical flex container's record takes
    # its items' content width from the oracle's box (`walkRecord` reads `_lb.width`). A trap that let the value
    # through would report it right — so this is the check that the instrument can fail at all, and revealing
    # that one stamp is the A/B that pins the break on it rather than on the trap's mere presence. When the
    # dependency moves into the native pass this shape stops breaking; swap in another BREAK from a
    # `CSIM_SWEEP_NO_ORACLE=1` sweep rather than deleting the example.
    s = session_with(<<~HTML)
      <div style="writing-mode:vertical-rl;display:flex;align-items:flex-end;width:60px;height:60px;align-content:center"><div style="width:30px;height:20px"></div><div style="width:40px;height:50px"></div></div>
    HTML
    run = ->(opts) { s.evaluate_script("globalThis.__csimLayoutShadowRun(undefined, #{opts})") }
    expect(run.('undefined')).to include('ok' => true, 'mismatches' => 0)

    hidden = run.('{noOracle: true}')
    expect(hidden).to include('ok' => true, 'oracleWrites' => 0)
    expect(hidden['mismatches']).to be > 0
    expect(hidden['oracleReads'].keys).to include('walkRecord _lb.width')

    revealed = run.("{noOracle: true, reveal: ['_lb']}")
    expect(revealed).to include('ok' => true, 'mismatches' => 0)
    expect(revealed['oracleReads'].keys).not_to include(a_string_matching(/ _lb(\.|$)/))
    # …and revealing a stamp the shape does not need changes nothing
    expect(run.("{noOracle: true, reveal: ['_lbCbH']}")['mismatches']).to eq(hidden['mismatches'])
  end

  it 'computes a memo again rather than serving the oracle its answer' do
    # A memo the oracle's pass left fresh is an oracle answer no trap sees: the helper behind it is never entered,
    # so it is never noted. A collapsing table resolves its borders over the grid `tableGrid` builds, memoised on
    # the table — served, the walk's dependency on that machinery vanished from the record.
    s = session_with('<table style="border-collapse:collapse"><tr><td style="border:3px solid">a</td><td>b c</td></tr></table>')
    r = s.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
    expect(r).to include('ok' => true, 'oracleWrites' => 0)
    expect(r['oracleReads'].keys).to include('ensureCollapseBorders helper:tableGrid')
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
end
