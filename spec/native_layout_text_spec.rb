# frozen_string_literal: true
# Native layout L2 (inline/text) — geometry shadow-parity: a text-containing block's native height
# (greedy line count × line-height, measured in-process via fontations) must equal the JS layout's `_lb`
# on pure-text blocks (single font, white-space:normal). Validates the native line breaker + text-block
# height against the JS oracle. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout L2 text-block parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def parity(session)
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def expect_parity(body)
    session = simulated_session(page(body)); session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a single-line text block' do
    session = simulated_session(page('<div>Hello world</div>'))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a multi-line wrapping text block' do
    text = 'The quick brown fox jumps over the lazy dog and then keeps on running well past the edge of the box.'
    session = simulated_session(page(%(<div style="width:150px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches nested block containers of text blocks' do
    session = simulated_session(page(<<~HTML))
      <div>
        <div style="width:120px">first paragraph of words that wraps onto multiple lines here</div>
        <div style="width:300px">second paragraph on probably one line</div>
      </div>
    HTML
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches text with same-font inline elements (a / span) folded in' do
    text = 'Some words with <a href="#">a link here</a> and a <span>span too</span> that keep wrapping onward.'
    session = simulated_session(page(%(<div style="width:160px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches text with different-font inline runs (bold / em)' do
    text = 'plain words then <b>some bold words</b> then <em>emphasised ones</em> and plain again onward.'
    session = simulated_session(page(%(<div style="width:170px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  # A mixed-font word — one glued across a run boundary with NO space between, because a plain (edgeless)
  # inline emits no OPEN/CLOSE run to separate the fonts: `foo<b>bar</b>baz`, `H<sub>2</sub>O`. It is ONE
  # unbreakable unit: the fonts differ but there is no line-break opportunity between the segments, so its
  # width is the sum of the per-font advances and the whole unit wraps together (its tail never spills).
  it 'matches a bold run glued mid-word' do
    expect_parity('<div style="width:300px">foo<b>bar</b>baz</div>')
  end
  it 'matches a subscript glued mid-word (H2O)' do
    expect_parity('<div style="width:300px">H<sub>2</sub>O and a longer <sub>subscripted</sub>word wrapping onward here past the edge</div>')
  end
  it 'matches a font-size change glued mid-word growing the line box' do
    expect_parity('<div style="width:300px">a<span style="font-size:24px">B</span>c then more plain words wrapping onward past the box edge here</div>')
  end
  it 'matches a three-font glued word' do
    expect_parity('<div style="width:400px">a<b>b</b><i>c</i>d and then several more plain words that wrap onward past the edge</div>')
  end
  # The glued unit is unbreakable; when its LEADING segment doesn't fit the line it wraps as one.
  it 'matches a glued mixed-font unit wrapping as one at the box edge' do
    expect_parity('<div style="width:70px">xxxxx yyyy<b>yyyy</b>yyyy and zzz</div>')
  end
  it 'matches a glued mixed-font prefix followed by a real space and more words' do
    expect_parity('<div style="width:120px">pre<b>fix</b>ed words then more that keep wrapping onward past the edge here</div>')
  end
  # The over-break guard: the glued unit's LEADING segment (`xx`) fits the current line but the WHOLE unit
  # (`xx` + the long bold tail) does not. The oracle's greedy breaker commits the unit to the line on the
  # leading segment alone and lets the tail OVERFLOW — a mid-word run boundary is never a break opportunity —
  # so this is ONE line. Fit-testing the whole unit instead would wrap it to a second line (a silent-wrong).
  it 'matches a glued unit whose leading segment fits but whose tail overflows the line (no extra break)' do
    expect_parity('<div style="width:120px">x xx<b>xxxxxxxxxxxxxxxx</b></div>')
  end
  it 'matches a subscript tail overflowing after a fitting leading segment' do
    expect_parity('<div style="width:90px">word H<sub>2222222222222</sub></div>')
  end

  # In-word breaking (overflow-wrap / word-break): a word WIDER than the band breaks between characters. The
  # oracle's charUnits emits one unit per code point and the flow fills greedily; native reproduces that in
  # line_layout (wrap_mode on the run). break-word / anywhere move the over-long word to a FRESH line first;
  # break-all fills the line it is on. A word that FITS the band still wraps as a whole (no in-word break).
  it 'matches overflow-wrap:break-word breaking a long unbroken word' do
    expect_parity('<div style="width:120px; overflow-wrap:break-word">see thisisaverylongunbrokenwordthatmustbreak here</div>')
  end
  it 'matches word-break:break-all filling each line' do
    expect_parity('<div style="width:120px; word-break:break-all">The quick brown fox jumps over the lazy dog repeatedly.</div>')
  end
  it 'matches overflow-wrap:anywhere breaking a long word' do
    expect_parity('<div style="width:100px; overflow-wrap:anywhere">prefix supercalifragilisticexpialidocious suffix</div>')
  end
  it 'matches word-wrap:break-word (the legacy spelling) on a long URL' do
    expect_parity('<div style="width:140px; word-wrap:break-word">Visit https://example.com/a/very/long/path/that/keeps/going/onward for details</div>')
  end
  # freshLine: break-word puts the whole word on its own line, THEN breaks it there (a leading short word
  # stays above); break-all has no fresh line and fills the current line — the counts differ, so this pins it.
  it 'matches break-word starting the over-long word on a fresh line' do
    expect_parity('<div style="width:110px; overflow-wrap:break-word">a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c</div>')
  end
  it 'matches break-all with no fresh line for the over-long word' do
    expect_parity('<div style="width:110px; word-break:break-all">a bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb c</div>')
  end
  # A break-anywhere word that FITS the band is atomic — it soft-wraps as a whole, no in-word split.
  it 'matches a break-word word that fits the band wrapping whole' do
    expect_parity('<div style="width:200px; overflow-wrap:break-word">alpha bravo charlie delta echo foxtrot golf hotel india</div>')
  end
  # The mode is per-run and inherits: only the break-all span breaks inside; the plain span does not.
  it 'matches a break-all span beside a plain span (per-run mode)' do
    expect_parity('<div style="width:130px"><span style="word-break:break-all">antidisestablishmentarianism</span> <span>and thennnnnnnnnnnnnnnnnnnn</span></div>')
  end
  it 'matches break-word inherited from an ancestor onto a nested span' do
    expect_parity('<div style="width:120px; overflow-wrap:break-word">lead <span>nestedsuperlongunbreakableword</span> tail</div>')
  end
  # white-space:nowrap suppresses ALL soft-wrapping, in-word breaking included — one line even with break-all.
  it 'matches nowrap + break-all staying on one line' do
    expect_parity('<div style="width:80px; white-space:nowrap; word-break:break-all">unbreakablelongwordonasingleline plus more</div>')
  end
  # pre-wrap preserves whitespace and still soft-wraps, so a long word breaks inside under break-word too.
  it 'matches pre-wrap + break-word breaking a long word' do
    expect_parity("<div style=\"width:120px; white-space:pre-wrap; overflow-wrap:break-word\">line one\nthisisaverylongwordunderprewrap end</div>")
  end
  # break-word on a nested block element inside a wider container: the run fills the nested block's own width.
  it 'matches break-word on a nested block element' do
    expect_parity('<div style="width:180px"><p style="overflow-wrap:break-word">areallylongunbreakableurlwordhere followed by ordinary words wrapping past edge</p></div>')
  end

  # <wbr> is a zero-width soft-wrap opportunity: it separates the runs it sits between (so they do not merge
  # into one glued word) and lets the next word break before it. This holds at white-space:normal too — the
  # native breaker ignored <wbr> entirely before, merging the flanking text and mis-breaking it.
  it 'matches a <wbr> break opportunity in a long token (normal wrapping)' do
    expect_parity('<div style="width:70px">aaaaaaaaaa<wbr>bbbbbbbbbb</div>')
  end
  it 'matches a <wbr> across a font boundary' do
    expect_parity('<div style="width:70px">aaaaaaaaaa<wbr><b>bbbbbbbbbb</b></div>')
  end
  it 'matches multiple <wbr> break points in a URL' do
    expect_parity('<div style="width:80px">https://<wbr>example<wbr>.com<wbr>/very<wbr>/long<wbr>/path/onward</div>')
  end
  it 'matches a <wbr> inside a break-word block (the over-long-token case)' do
    expect_parity('<div style="width:70px; overflow-wrap:break-word">aaaaaaaaaa<wbr>bbbbbbbbbbbbbbbbbbbb</div>')
  end
  it 'matches a <wbr> just after a real space (space width preserved)' do
    expect_parity('<div style="width:70px">aaaa <wbr>bbbbbbbbbbbb</div>')
  end
  # A <wbr> immediately BEFORE a collapsible space must not swallow that space's advance — the space still
  # separates the words (width tuned so `aaaabbbb` fits one line but `aaaa bbbb` does not).
  it 'matches a <wbr> immediately before a collapsible space' do
    expect_parity('<div style="width:61px">aaaa<wbr> bbbb</div>')
  end
  it 'matches a <wbr> suppressed under white-space:nowrap' do
    expect_parity('<div style="width:60px; white-space:nowrap">aaaaaaaa<wbr>bbbbbbbb ccc</div>')
  end

  it 'matches a larger-font inline run growing the line height' do
    session = simulated_session(page(%(<div style="width:300px">small text <span style="font-size:28px">BIG</span> small again</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a fixed line-height with mixed font metrics (ascent/descent line box)' do
    # A LENGTH line-height does not scale per run, so the taller 28px run's ascent grows the line box
    # past the 40px line-height — max(ascent)+max(descent), not max(line-height). Diverges unless native
    # composes the line box from per-run ascent/descent.
    session = simulated_session(page(%(<div style="width:400px;line-height:40px">small text <span style="font-size:28px">BIG</span> more small text</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches <br> hard breaks (mid, trailing, leading, doubled)' do
    [
      'line one<br>line two',
      'only line<br>',
      '<br>after a leading break',
      'a<br><br>b with a blank line between',
      'first<br>second<br>third',
    ].each do |body|
      session = simulated_session(page(%(<div style="width:400px">#{body}</div>)))
      session.visit '/'
      r = parity(session)
      expect(r).to include('ok' => true), "harness bailed on #{body.inspect}: #{r.inspect}"
      expect(r['mismatches']).to eq(0), "mismatch on #{body.inspect}: #{r.inspect}"
    end
  end

  it 'matches an edged inline element (padding/border/margin) affecting wrap' do
    text = 'some words then <span style="padding:0 10px;border:1px solid #000;margin:0 6px">a boxed span</span> and more words that wrap onward here.'
    session = simulated_session(page(%(<div style="width:200px">#{text}</div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  it 'matches a text block with padding, border, and margins' do
    text = 'Some words wrapping inside a padded bordered box to check content width and stacked height.'
    session = simulated_session(page(%(<div style="width:180px;margin:12px 0;padding:6px;border:2px solid #000">#{text}</div><div style="height:10px"></div>)))
    session.visit '/'
    r = parity(session)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  # An EDGED (horizontal padding / border / margin) inline whose font CONTENT-AREA exceeds the line-height grows
  # the block to that content-area box — the oracle makes `a<span style="padding:0 5px">x</span>` in an 8px
  # line-height 22 tall (the font box), where a NON-edged span stays at the line-height. Native's line box uses
  # the strut line-height and would under-size it, so it declines this until it grows an edged inline's line box
  # to its content area. A tiny line-height forces the trigger on any host (font-independent). A non-edged span
  # in the same block stays native.
  it 'declines an edged inline whose content-area exceeds the line-height' do
    session = simulated_session(page('<div style="line-height:8px;width:200px">a<span style="padding:0 5px">x</span>b</div>'))
    session.visit '/'
    expect(parity(session)).to include('ok' => false)
  end
  it 'declines a bordered inline whose content-area exceeds the line-height' do
    session = simulated_session(page('<div style="line-height:8px;width:200px">a<span style="border-left:2px solid">x</span>b</div>'))
    session.visit '/'
    expect(parity(session)).to include('ok' => false)
  end

  # A `vertical-align` baseline SHIFT (sub / super / length / %) on an inline element offsets its whole content —
  # its runs ride the shift, growing the line box the block's height reflects. Native threads the accumulated
  # shift through the run stream. (`middle` / `text-top` / `text-bottom`, which place against a box, still decline.)
  ['<sup>x</sup>', '<sub>x</sub>', '<span style="vertical-align:super">x</span>',
   '<span style="vertical-align:sub">x</span>', '<span style="vertical-align:6px">x</span>',
   '<span style="vertical-align:-4px">x</span>', '<span style="vertical-align:40%">x</span>'].each do |el|
    it "matches an inline vertical-align shift #{el[0, 30]}" do
      expect_parity(%(<div style="width:300px">text before #{el} and after text</div>))
    end
  end
  it 'matches nested vertical-align shifts (a sub inside a sup accumulate)' do
    expect_parity('<div style="width:300px">base <sup>up <sub>back down</sub> up</sup> base</div>')
  end
  it 'matches a shifted inline wrapping across lines' do
    expect_parity('<div style="width:120px">word word <span style="vertical-align:super">up</span> word word word word</div>')
  end
  # A shifted element raises only its DIRECTLY-owned text; a NESTED inline child stays on the baseline (the
  # oracle does not raise it), so the line box does not grow — the common `<sup><a>1</a></sup>` footnote-link.
  it 'matches a superscript wrapping a link (nested text stays on the baseline)' do
    expect_parity('<div style="width:300px">footnote <sup><a href="#">1</a></sup> here</div>')
  end
  it 'matches a shift whose text is inside a nested span (no line growth)' do
    expect_parity('<div style="width:300px">a <span style="vertical-align:super"><span>text</span></span> b</div>')
  end
  it 'matches a shift wrapping bold nested content (no line growth)' do
    expect_parity('<div style="width:300px">a <sup><b>1</b></sup> b</div>')
  end
  # A whitespace-only inline in a larger font is a fragment on the line it sits on and grows the line box
  # (Chrome: 47 for `a<span style="font-size:40px"> </span>b` in a 16px block); native never grew a line for a
  # placed collapsed space (review finding). The ORACLE grows it only where the space stays — a space the wrap
  # drops grows nothing there, where Chrome grows a line for ANY inline fragment on it (CSS 2.1 §10.8: an empty
  # inline, a dropped space, a <br> inside a larger inline). That is a shared gap of both engines, kept in
  # parity here and tracked as a backlog item; these cases pin the parity, not Chrome.
  it 'grows a line for a placed whitespace-only inline of a larger font (the oracle: not for a space the wrap drops)' do
    expect_parity('<div style="width:300px"><div>a<span style="font-size:40px"> </span>b</div></div>')
    expect_parity('<div style="width:300px"><div>a <span style="font-size:40px"> </span> b</div></div>')
    expect_parity('<div style="width:60px"><div>aaaa<span style="font-size:40px"> </span>bbbb cccc</div></div>')
    expect_parity('<div style="width:300px"><div><span style="font-size:40px"> </span>a</div></div>')
    expect_parity('<div style="width:300px;white-space:pre"><div>a<span style="font-size:40px"> </span>b</div></div>')
    expect_parity('<div style="width:60px;white-space:pre-wrap"><div>aaaa<span style="font-size:40px"> </span>bbbb</div></div>')
    expect_parity('<div style="width:60px"><div>aaaa<span style="font-size:40px"> </span><span style="display:inline-block;width:30px;height:5px"></span></div></div>')
  end

end

RSpec.describe 'native text valign decline', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0;font:16px monospace\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def expect_bail(body)
    session = simulated_session(page(body)); session.visit '/'
    r = session.evaluate_script('document.body.offsetHeight')
    expect(session.evaluate_script('globalThis.__csimLayoutShadowRun()')).to include('ok' => false)
  end

  it('declines vertical-align:middle on an inline element') { expect_bail('<div style="width:300px">text <span style="vertical-align:middle">m</span> here</div>') }
  it('declines vertical-align:text-top on an inline element') { expect_bail('<div style="width:300px">text <span style="vertical-align:text-top">t</span> here</div>') }

  # A forced break INSIDE an inline's edges splits the box into fragments whose edges native's line layout
  # cannot place (its `RUN_BR` arm declines an open edge), so the walk declines the block rather than let the
  # pass fail on it. An unedged inline around a `<br>` emits no edge runs and stays native.
  it('declines a break inside a padded inline') { expect_bail('<div style="width:400px">x <b style="padding:0 5px">t<br>u</b> y</div>') }
  it('declines a break inside a bordered inline') { expect_bail('<div style="width:400px">x <b style="border-left:2px solid">t<br>u</b> y</div>') }
  it('declines a break inside a margined inline') { expect_bail('<div style="width:400px">x <b style="margin:0 5px"><br></b> y</div>') }
end
