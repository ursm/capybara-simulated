# frozen_string_literal: true
# Native layout L2 (inline/text) — geometry shadow-parity: a text-containing block's native height
# (greedy line count × line-height, measured in-process via fontations) must equal the JS layout's `_lb`
# on pure-text blocks (single font, white-space:normal). Validates the native line breaker + text-block
# height against the JS oracle. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout L2 text-block parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  # The charset is declared because the CJK shapes below are UTF-8 in this file's own source: served without
  # it they would decode as windows-1252 and the specs would be testing mojibake rather than Japanese.
  def page(body)
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
  end

  def parity(session)
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def shadow(body)
    session = simulated_session(page(body)); session.visit '/'
    parity(session)
  end

  def expect_parity(body)
    r = shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{body}: #{r.inspect}"
    expect(r['compared']).to be > 0, "nothing was compared: #{body}: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{body}: #{r.inspect}"
  end

  it 'matches a single-line text block' do
    expect_parity('<div>Hello world</div>')
  end

  it 'matches a multi-line wrapping text block' do
    text = 'The quick brown fox jumps over the lazy dog and then keeps on running well past the edge of the box.'
    expect_parity(%(<div style="width:150px">#{text}</div>))
  end

  it 'matches nested block containers of text blocks' do
    expect_parity(<<~HTML)
      <div>
        <div style="width:120px">first paragraph of words that wraps onto multiple lines here</div>
        <div style="width:300px">second paragraph on probably one line</div>
      </div>
    HTML
  end

  it 'matches text with same-font inline elements (a / span) folded in' do
    text = 'Some words with <a href="#">a link here</a> and a <span>span too</span> that keep wrapping onward.'
    expect_parity(%(<div style="width:160px">#{text}</div>))
  end

  it 'matches text with different-font inline runs (bold / em)' do
    text = 'plain words then <b>some bold words</b> then <em>emphasised ones</em> and plain again onward.'
    expect_parity(%(<div style="width:170px">#{text}</div>))
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
    expect_parity(%(<div style="width:300px">small text <span style="font-size:28px">BIG</span> small again</div>))
  end

  it 'matches a fixed line-height with mixed font metrics (ascent/descent line box)' do
    # A LENGTH line-height does not scale per run, so the taller 28px run's ascent grows the line box
    # past the 40px line-height — max(ascent)+max(descent), not max(line-height). Diverges unless native
    # composes the line box from per-run ascent/descent.
    expect_parity(%(<div style="width:400px;line-height:40px">small text <span style="font-size:28px">BIG</span> more small text</div>))
  end

  it 'matches <br> hard breaks (mid, trailing, leading, doubled)' do
    [
      'line one<br>line two',
      'only line<br>',
      '<br>after a leading break',
      'a<br><br>b with a blank line between',
      'first<br>second<br>third',
    ].each do |body|
      expect_parity(%(<div style="width:400px">#{body}</div>))
    end
  end

  it 'matches an edged inline element (padding/border/margin) affecting wrap' do
    text = 'some words then <span style="padding:0 10px;border:1px solid #000;margin:0 6px">a boxed span</span> and more words that wrap onward here.'
    expect_parity(%(<div style="width:200px">#{text}</div>))
  end

  it 'matches a text block with padding, border, and margins' do
    text = 'Some words wrapping inside a padded bordered box to check content width and stacked height.'
    expect_parity(%(<div style="width:180px;margin:12px 0;padding:6px;border:2px solid #000">#{text}</div><div style="height:10px"></div>))
  end

  # An EDGED (horizontal padding / border / margin) inline whose font CONTENT-AREA exceeds the line-height grows
  # the block to that content-area box — the oracle makes `a<span style="padding:0 5px">x</span>` in an 8px
  # line-height 22 tall (the font box), where a NON-edged span stays at the line-height. Native's line box uses
  # the strut line-height and would under-size it, so it declines this until it grows an edged inline's line box
  # to its content area. A tiny line-height forces the trigger on any host (font-independent). A non-edged span
  # in the same block stays native.
  it 'declines an edged inline whose content-area exceeds the line-height' do
    expect(shadow('<div style="line-height:8px;width:200px">a<span style="padding:0 5px">x</span>b</div>')).to include('ok' => false)
  end
  it 'declines a bordered inline whose content-area exceeds the line-height' do
    expect(shadow('<div style="line-height:8px;width:200px">a<span style="border-left:2px solid">x</span>b</div>')).to include('ok' => false)
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

  # A WIDE character — CJK, fullwidth, Hangul — is its own break unit, which is what makes a Japanese paragraph
  # wrap at all: it has no spaces to break at. Native cuts the same units the oracle's `charUnits` does
  # (`break_unit_len`: a wide character alone, a maximal non-wide run otherwise), in the flow and in the
  # min-content measure alike. Until this, such a run reached Rust, `measure_run` answered None and the whole
  # PASS was discarded — so every Japanese page fell back to the oracle entirely.
  describe 'wide characters break between themselves' do
    it 'wraps a CJK run between characters, and measures its min-content as one' do
      expect_parity('<div style="width:100px">日本語のテキストです</div>')
      expect_parity('<div style="width:100px">これは長い日本語の文章で折り返しが必要になります</div>')
      expect_parity('<div style="width:400px">日本語</div>')
      expect_parity('<div style="width:100px">mixed 日本語 and ascii text here</div>')
      expect_parity('<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>日本語のテキスト</div><div>x</div></div>')
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0">日本語のテキスト</td><td style="padding:0">bb</td></tr></table>')
    end
    # A wide character is an opportunity on BOTH sides, across a run boundary too — two text nodes, or a
    # `<span>` between them, are one word to the flow otherwise. An astral emoji is NOT one (the oracle's
    # `isWideChar` is BMP-only), and a ZWJ sequence must not be split into per-surrogate units.
    it 'breaks beside a wide character across a run boundary, and not around an astral one' do
      expect_parity('<div style="width:60px">日本語<span>abcdefghijkl</span></div>')
      expect_parity('<div style="width:60px"><span>日本語</span>abcdefghijkl</div>')
      expect_parity('<div style="width:60px">abc<span>defghijkl</span></div>')
      expect_parity('<div style="width:100px">aaaaaaaaaaaa&#x1F600;bbbbbbbbbbbb</div>')
      expect_parity('<div style="display:inline-block"><span>&#x1F468;&#x200D;&#x1F469;&#x200D;&#x1F467;</span></div>')
    end
    # The opportunity a wide character leaves has to cross a RUN boundary, because that is where the two
    # engines can disagree: native merges only same-font runs, so a plain `<b>` around a Japanese word — or a
    # padded inline, or a different size — splits them, and without carrying the opportunity native glued what
    # the oracle (and Chrome) break. Both directions: a run ENDING wide, and a word STARTING wide.
    it 'breaks beside a wide character across a font, weight or padding boundary' do
      expect_parity('<div style="width:60px">abcdefghij<b>日本語</b>klmnopqrst</div>')
      expect_parity('<div style="width:60px"><b style="padding-right:4px">日本語</b>abcdefghij</div>')
      expect_parity('<div style="width:60px">日本語<span style="font-size:24px">abcdefghijkl</span></div>')
      expect_parity('<div style="width:60px">abcdefgh<span style="font-size:24px">日</span>ijklmnop</div>')
      expect_parity('<div style="width:60px">abc<span style="font-size:24px">日本語</span>def</div>')
      expect_parity('<div style="width:60px">日本語<span style="font-size:24px">日本語</span>日本語</div>')
      expect_parity('<table style="border-spacing:0"><tr><td style="padding:0;width:60px">日本語<span style="font-size:24px">abcdefghijkl</span></td></tr></table>')
      # …and the MIN-CONTENT of a word whose wide character is not at its edge: only the wide unit is an
      # opportunity there (`own`), so the Latin run before it stays glued to the run before THAT — bracketing
      # every unit closed the word early and measured 42.63 where the oracle says 59.53, and lost a padded
      # inline's 20px edge outright.
      ['<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>%s</div><div>x</div></div>'].each do |wrap|
        expect_parity(format(wrap, 'abcdef<b>gh日</b>'))
        expect_parity(format(wrap, '<b>日ab</b>cdefgh'))
        expect_parity(format(wrap, '<span style="padding-left:20px">abcd日</span>'))
        expect_parity(format(wrap, 'abcdef日'))
      end
      # …and the ASCII shapes it must not move: a mid-word run boundary is still no opportunity
      expect_parity('<div style="width:60px">abcdefghij<b>klm</b>nopqrst</div>')
      expect_parity('<div style="width:60px">abc<span style="font-size:24px">def</span>ghi</div>')
    end
    # …and per-character breaking is the OWNER's mode: one CJK character in a paragraph must not stop its Latin
    # words from breaking, nor route them through the unspaced measure that drops their letter-spacing.
    it 'keeps break-all over the Latin words of a mixed paragraph' do
      expect_parity('<div style="display:flex;width:50px"><div style="word-break:break-all">&#x65E5; abcdefghijklmnop</div></div>')
      expect_parity('<div style="display:flex;width:50px"><div style="word-break:break-all"><span>&#x65E5;</span> abcdefghijklmnop</div></div>')
      expect_parity('<div style="display:inline-block;letter-spacing:4px"><span>&#x65E5; abcdefgh</span></div>')
      # …while a word that DOES hold one still breaks per code point under that mode (`own = perChar || wide`),
      # tail included — grouping the Latin tail back into one unit measured 58.63 against the oracle's 50.
      expect_parity('<div style="display:flex;width:50px"><div style="word-break:break-all">&#x65E5;abcdefgh</div></div>')
    end
    # A COLLAPSED tab is measured by nobody — the whitespace run never reaches `measure_run` — so tab-indented
    # markup lays out natively; only a PRESERVED one declines.
    it 'lays out tab-indented markup and declines only a preserved tab' do
      expect_parity("<div style=\"width:400px\">\n\t<span>hello</span>\n</div>")
      expect(shadow("<div style=\"width:400px;white-space:pre\">a\tb</div>")).to include('ok' => false)
    end
    it 'keeps the wrap modes and spacing over a CJK run' do
      expect_parity('<div style="width:60px;word-break:break-all">日本語のテキスト</div>')
      expect_parity('<div style="width:60px;overflow-wrap:anywhere">日本語のテキスト</div>')
      expect_parity('<div style="width:60px;white-space:nowrap">日本語のテキスト</div>')
      expect_parity('<div style="width:60px;white-space:pre-wrap">日本語の テキスト</div>')
      expect_parity('<div style="width:60px;letter-spacing:2px">日本語のテキスト</div>')
    end
    # …and the same undecidable arm took down every OTHER character at or above U+0300, because whether one is a
    # combining mark is the question `zero_width` could not answer. It answers it from `combining.rs` now.
    it 'measures a space, a dash, an emoji and a combining mark' do
      expect_parity('<div style="width:400px">a&#x2003;b</div>')
      expect_parity('<div style="width:400px">a&#x2002;b</div>')
      expect_parity('<div style="width:400px">a&#x3000;b</div>')
      expect_parity('<div style="width:400px">a&#x00B7;b</div>')
      expect_parity('<div style="width:400px">caf&#x00E9; na&#x00EF;ve</div>')
      expect_parity('<div style="width:400px">&#x0301;a</div>')
      expect_parity('<div style="width:400px">&#x2764;&#xFE0F;</div>')
      expect_parity('<div style="width:400px">&#x1F600;&#x1F601;</div>')
    end

    # The table `zero_width` answers from is GENERATED (script/gen_combining_marks.rb) from this engine's own
    # `\p{M}`, because that is what the oracle asks. Ruby's Unicode tables are a different version and disagree
    # (8 ranges when this was written), and either side can move on an upgrade — so re-ask the engine at every
    # range boundary. A drift reds here instead of showing up as a character measured wider in one engine.
    it 'agrees with the engine at every combining-mark range boundary' do
      table = File.read(File.expand_path('../ext/csim_native/src/combining.rs', __dir__)).scan(/\(0x([0-9A-F]+), 0x([0-9A-F]+)\),/)
                  .map {|lo, hi| [lo.to_i(16), hi.to_i(16)] }
      expect(table.size).to be > 300, 'the generated table looks empty'
      # Each range's edges, plus the MIDPOINT of every gap between them: a Unicode upgrade that adds a range
      # where the table has none is invisible to an edges-only probe.
      gaps   = table.each_cons(2).map {|(_, hi), (lo, _)| (hi + lo) / 2 }
      probes = (table.flat_map {|lo, hi| [lo - 1, lo, hi, hi + 1] } + gaps).uniq.select {|cp| cp >= 0x300 && cp <= 0x10FFFF }
      expected = probes.map {|cp| table.any? {|lo, hi| cp.between?(lo, hi) } }
      session = simulated_session(page('<div>x</div>')); session.visit '/'
      actual = session.evaluate_script(<<~JS)
        (() => {
          const re = new RegExp('^' + String.fromCharCode(92) + 'p{M}$', 'u');
          return #{probes.inspect}.map((cp) => (cp >= 0xD800 && cp <= 0xDFFF) ? false : re.test(String.fromCodePoint(cp)));
        })()
      JS
      drift = probes.each_index.reject {|i| expected[i] == actual[i] }
                    .map {|i| format('U+%04X table=%s engine=%s', probes[i], expected[i], actual[i]) }
      expect(drift).to be_empty, "regenerate ext/csim_native/src/combining.rs:\n#{drift.first(12).join("\n")}"
    end

    # What native still cannot measure is refused by the WALK now, not discovered in Rust: a TAB needs the
    # block's tab stops, and a ZWJ under a per-character wrap carries the previous character's advance.
    it 'declines a tab and a per-character ZWJ in the walk' do
      ["<div style=\"width:400px;white-space:pre\">a\tb</div>",
       '<div style="width:400px;word-break:break-all">a&#x200D;b</div>'].each do |body|
        expect(shadow(body)).to include('ok' => false, 'reason' => 'unsupported subtree'), body
      end
    end
  end
  # `text-indent` narrows the line it is on from the START edge — the right one in rtl — rather than moving a
  # cursor inside it, so an indented empty line is still empty. Which lines take it: the first, or with
  # `hanging` every line BUT the first, and with `each-line` the first after every forced break as well. It was
  # the walk's most common decline after auto margins, and it is on BOTH figures the intrinsic measure returns.
  # A `<br clear>` clears the floats before the next line, which native's line layout does not model — and the
  # walk read the TAG and not the attribute, so it laid such a block out 18px short and only a Chrome comparison
  # saw it. Declined until native models the clearance.
  it 'declines a <br> carrying a clear' do
    expect(shadow('<div style="display:flow-root;width:300px"><div style="float:left;width:100px;height:40px"></div><div>aa<br clear="left">bb</div></div>')).to include('ok' => false)
    expect(shadow('<div style="width:300px">aa<br clear="both">bb</div>')).to include('ok' => false)
    # …a plain `<br>` in the same float context stays native
    expect_parity('<div style="display:flow-root;width:300px"><div style="float:left;width:100px;height:40px"></div><div>aa<br>bb</div></div>')
  end

  describe 'text-indent narrows the lines it is on' do
    it 'indents the first line, and wraps around the narrower line' do
      expect_parity('<div style="width:200px;text-indent:40px">one two three four five six seven eight</div>')
      expect_parity('<div style="width:200px;text-indent:40px"><span style="display:inline-block;width:10px;height:10px"></span> tail</div>')
      expect_parity('<div style="width:200px;text-indent:-30px">one two three four five six seven eight</div>')
      # …a PERCENTAGE against the block's own CONTENT width, not its border box
      expect_parity('<div style="width:200px;padding:0 20px;border-left:10px solid;text-indent:20%">one two three four five six</div>')
    end
    it 'indents every line but the first under hanging, and after a forced break under each-line' do
      expect_parity('<div style="width:200px;text-indent:40px hanging"><span style="display:inline-block;width:10px;height:10px"></span> one two three four five six seven</div>')
      expect_parity('<div style="width:200px;text-indent:40px each-line">x<br><span style="display:inline-block;width:10px;height:10px"></span> two</div>')
      expect_parity('<div style="width:200px;text-indent:40px">x<br><span style="display:inline-block;width:10px;height:10px"></span> two</div>')
    end
    # In a MIXED block the indent is the BLOCK's, not each anonymous group's: only "is this the block's first
    # line" is one-shot — the first group that places a line takes it, and a block-level child spends whatever
    # no line took (Chrome puts the span after the inner block at x=0, not at 40). The PER-LINE rules go on
    # applying in every later group, which is what these wrapping cases pin: writing the indent to the first
    # group alone left a later group's `hanging` lines flush (native 77 where Chrome says 113).
    it 'gives a mixed block its indent once, and a block child spends it' do
      expect_parity('<div style="width:200px;text-indent:40px">text <div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      expect_parity('<div style="width:200px;text-indent:40px"><div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      expect_parity('<div style="width:200px;text-indent:40px">  <div style="height:5px"></div><span style="display:inline-block;width:10px;height:10px"></span> after</div>')
      # …and the LINE COUNT of a group after the block child, where the per-line rules actually show
      words = 'aa bb cc dd ee ff gg hh ii jj kk ll mm nn'
      expect_parity(%(<div style="width:100px;text-indent:40px hanging">x<div style="height:5px"></div>#{words}</div>))
      expect_parity(%(<div style="width:100px;text-indent:40px each-line">x<div style="height:5px"></div>q<br>#{words}</div>))
      expect_parity(%(<div style="width:100px;text-indent:40px">x<div style="height:5px"></div>#{words}</div>))
      expect_parity(%(<div style="width:100px;text-indent:-20px">#{words}</div>))
    end
    # …and it is on the first line of BOTH intrinsic figures, where a PERCENTAGE resolves against nothing —
    # which is what leaves the `text-indent: -9999px` hidden-label idiom its padding.
    # …but an INTRINSIC measure of an indented block stays with the oracle. What Chrome's min-content does with
    # an indent is a real break pass at zero available width — a break at an ITEM boundary always taken, one
    # inside a text item taken only on overflow — where this engine's measure is an accumulator that agrees only
    # when the first line opens with a plain word. Four review rounds of near-miss rules came out of trying to
    # mirror it (an empty inline, a `<wbr>`, a leading space, a negative indent and a soft hyphen each broke a
    # different one), so a MEASURED indented block declines and its caller takes the fallback it already has.
    it 'declines an indented block whose intrinsic widths native would measure' do
      # Each pair is the same shape with and without the indent: the indented one takes its caller's FALLBACK
      # (the oracle's contribution / box) where the plain one is measured natively, and the pass lays out either
      # way — the decline is a route change, not a bail.
      [['<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div style="%s">aa bb</div><div>x</div></div>', 'nativeIntrinsicGrids'],
       ['<div style="display:grid;grid-template-columns:max-content auto;width:400px"><div style="%s">aa bb</div><div>x</div></div>', 'nativeIntrinsicGrids'],
       ['<div style="width:400px">a <span style="display:inline-block;%s">bb cc</span></div>', 'nativeAtomics']].each do |shape, key|
        indented = shadow(format(shape, 'text-indent:20px'))
        plain    = shadow(format(shape, ''))
        expect(indented).to include('ok' => true, 'mismatches' => 0), shape
        expect(indented[key]).to eq(0), "#{key} with the indent: #{indented.inspect}"
        expect(plain[key]).to be > 0, "#{key} without it: #{plain.inspect}"
      end
      # …a `<td>` pushes its own contribution instead, and the hidden-label idiom keeps the oracle's box.
      cell = shadow('<table style="border-spacing:0"><tr><td style="padding:0;text-indent:20px">aa bb</td><td style="padding:0">cc</td></tr></table>')
      expect(cell).to include('ok' => true, 'mismatches' => 0)
      expect(cell['pushedContributions']).to be > 0, cell.inspect
      expect_parity('<div style="display:inline-block;padding:0 5px;text-indent:-9999px">Label</div>')
      expect_parity('<div style="display:flex;width:400px"><div style="text-indent:30px">aa bb</div></div>')
    end
    # A line's room for content is its band LESS the indent, and the band it drops to has to hold both: a 70px
    # inline-block under a 60px indent beside a 200px float of 300 clears the float (Chrome), where both engines
    # used to keep it beside — and a NEGATIVE indent keeps a line beside a float it would otherwise clear.
    it 'fits a line beside a float on the indented width' do
      float = '<div style="float:left;width:200px;height:40px"></div>'
      wide  = '<div style="float:left;width:250px;height:40px"></div>'
      ib    = '<span style="display:inline-block;width:70px;height:10px"></span>'
      expect_parity(%(<div style="display:flow-root;width:300px">#{float}<div style="text-indent:60px">#{ib}</div></div>))
      expect_parity(%(<div style="display:flow-root;width:300px">#{wide}<div style="text-indent:-30px">#{ib}</div></div>))
      expect_parity(%(<div style="display:flow-root;width:300px">#{wide}<div style="text-indent:-9999px">wwwwwwwwww</div></div>))
      expect_parity(%(<div style="display:flow-root;width:300px">#{float}<div>#{ib}</div></div>))
    end
  end

end

RSpec.describe 'native text valign decline', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0;font:16px monospace\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def expect_bail(body)
    session = simulated_session(page(body)); session.visit '/'
    session.evaluate_script('document.body.offsetHeight')   # force a layout pass
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
