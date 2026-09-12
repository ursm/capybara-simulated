# frozen_string_literal: true
# Native layout — INLINE ATOMICS, geometry shadow-parity. An atomic inline is a single box on a line. Native
# lays out an `inline-block` / inline `<img>` at its baseline (or a baseline shift) ITSELF — see the last
# describe; every other atomic (an inline-flex / grid / table, a control, one aligned against the parent's font
# box) is PUSHED: the oracle resolved its box (`_lb`) and baseline (`growAtomic`), and native replays those as a
# RUN_ATOMIC — the margin-box width is its advance, its ascent (+ descent) grow the line box. A pushed box is
# not compared (like every inline fragment in a text block); what's validated is the text block's line-broken
# HEIGHT. Still declines: a `top` / `bottom` vertical-align. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout inline-atomic parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    html = "<!doctype html><html><head></head><body style=\"margin:0\">#{body}</body></html>"
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] } }.to_app
  end

  def run_shadow(body)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script('document.body.offsetHeight')
    session.evaluate_script('globalThis.__csimLayoutShadowRun()')
  end

  def expect_parity(body)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
  end

  def expect_bail(body)
    expect(run_shadow(body)).to include('ok' => false)
  end

  it 'matches an inline svg between words on one line' do
    expect_parity('<div style="width:300px">ab <svg width="20" height="16"></svg> cd</div>')
  end
  it 'matches an inline svg TALLER than the text (grows the line box)' do
    expect_parity('<div style="width:300px;font-size:12px">x <svg width="30" height="40"></svg> y</div>')
  end
  it 'matches an inline svg SHORTER than the text (line box unchanged)' do
    expect_parity('<div style="width:300px;font-size:20px">x <svg width="8" height="6"></svg> y</div>')
  end
  it 'matches an img that forces a line wrap' do
    expect_parity('<div style="width:70px">aa <img width="40" height="10"> bb cc</div>')
  end
  it 'matches an inline svg with horizontal margins (advance includes them)' do
    expect_parity('<div style="width:300px">a <svg width="20" height="20" style="margin:0 8px"></svg> b</div>')
  end
  it 'matches two icons and text on a line' do
    expect_parity('<div style="width:300px">go <svg width="16" height="16"></svg> <img width="16" height="16"> now</div>')
  end
  it 'matches an icon at the very start of the block' do
    expect_parity('<div style="width:300px"><svg width="24" height="24"></svg> label</div>')
  end
  it 'matches an explicitly display:inline svg control-shaped box among words' do
    expect_parity('<div style="width:400px">name <svg width="90" height="22"></svg> ok</div>')
  end
  it 'matches an icon glued to a word (no space between)' do
    expect_parity('<div style="width:300px">price<svg width="12" height="12"></svg></div>')
  end

  # An atomic is a break opportunity on BOTH sides even with NO whitespace: a glued atomic/word that overflows
  # must still wrap (regression guards for review Finding 1).
  it 'matches a glued atomic AFTER a word that overflows (breaks before the atomic)' do
    expect_parity('<div style="width:60px">aaaaaaaa<svg width="40" height="10"></svg></div>')
  end
  it 'matches a glued word AFTER an atomic that overflows (breaks before the word)' do
    expect_parity('<div style="width:60px"><svg width="40" height="10"></svg>aaaaaaaa</div>')
  end
  it 'matches an atomic between two glued words that overflow' do
    expect_parity('<div style="width:90px">aaaa<img width="40" height="10">bbbbbbbb</div>')
  end
  # An atomic's margin-top rides its ASCENT, not its descent (regression guard for review Finding 2).
  it 'matches an atomic with a large margin-top on a tall-line block' do
    expect_parity('<div style="width:300px;font:16px/40px monospace">x<svg width="6" height="6" style="margin-top:20px"></svg> y</div>')
  end
  it 'matches an atomic with a small margin-top among normal text' do
    expect_parity('<div style="width:300px;font-size:16px">x<img width="1" height="1" style="margin-top:5px"> y</div>')
  end
  it 'matches an atomic with an asymmetric top/bottom margin' do
    expect_parity('<div style="width:300px;font-size:14px">a <svg width="10" height="10" style="margin:9px 0 3px"></svg> b</div>')
  end

  # INLINE-BLOCK / INLINE-FLEX atomics (slice 2): a box on the line whose content native does NOT lay out —
  # only its oracle-resolved advance + baseline reach the line, exactly like an inline replaced atomic.
  it 'matches an empty inline-block box among words' do
    expect_parity('<div style="width:300px">x <span style="display:inline-block;width:20px;height:20px"></span> y</div>')
  end
  it 'matches an inline-block with TEXT content (its own baseline)' do
    expect_parity('<div style="width:300px;font-size:16px">go <span style="display:inline-block">tag</span> now</div>')
  end
  it 'matches an inline-block TALLER than the text (grows the line)' do
    expect_parity('<div style="width:300px;font-size:12px">a <span style="display:inline-block;width:20px;height:40px"></span> b</div>')
  end
  it 'matches an inline-block with margins and padding' do
    expect_parity('<div style="width:300px">a <span style="display:inline-block;width:20px;height:16px;margin:0 6px;padding:2px"></span> b</div>')
  end
  it 'matches an inline-block form control in text (default inline-block)' do
    expect_parity('<div style="width:400px">name <input type="text" style="width:90px;height:22px"> ok</div>')
  end
  it 'matches an inline-flex box among words' do
    expect_parity('<div style="width:300px">x <span style="display:inline-flex;width:24px;height:18px"></span> y</div>')
  end
  it 'matches an inline-block that forces a wrap' do
    expect_parity('<div style="width:80px">aaaa <span style="display:inline-block;width:50px;height:10px"></span> bbbb</div>')
  end
  it 'matches an inline-block glued to a word that overflows' do
    expect_parity('<div style="width:70px">aaaaaaaa<span style="display:inline-block;width:40px;height:10px"></span></div>')
  end

  # A `vertical-align` that only shifts the atomic's ASCENT within the line (baseline shift — super / sub /
  # length / %, or middle / text-top / text-bottom against the parent's font box) is reproduced by pushing the
  # va-adjusted ascent (`alignedAscent`) — or, for a shifted inline-block native lays out itself, by carrying
  # the shift on its run; the Rust line layout grows the line box around it either way. Only `top` / `bottom`,
  # which align to the LINE box itself (height not known until the line closes), still decline.
  it 'matches a super-aligned atomic (baseline shift raises it and grows the line)' do
    expect_parity('<div style="width:300px">x <svg width="10" height="10" style="vertical-align:super"></svg> y</div>')
  end
  it 'matches a super-aligned inline-block atomic' do
    expect_parity('<div style="width:300px">x <span style="display:inline-block;width:10px;height:10px;vertical-align:super"></span> y</div>')
  end
  it 'matches a sub-aligned inline-block atomic (baseline shift down)' do
    expect_parity('<div style="width:300px">x <span style="display:inline-block;width:10px;height:14px;vertical-align:sub"></span> y</div>')
  end
  it 'matches a middle-aligned atomic (centred half an x-height above the baseline)' do
    expect_parity('<div style="width:300px;font-size:16px">text <span style="display:inline-block;width:12px;height:24px;vertical-align:middle"></span> more</div>')
  end
  it 'matches a text-top-aligned atomic (top on the parent ascent)' do
    expect_parity('<div style="width:300px">text <span style="display:inline-block;width:12px;height:12px;vertical-align:text-top"></span> more</div>')
  end
  it 'matches a text-bottom-aligned atomic (bottom on the parent descent)' do
    expect_parity('<div style="width:300px">text <span style="display:inline-block;width:12px;height:12px;vertical-align:text-bottom"></span> more</div>')
  end
  it 'matches a length-shifted atomic' do
    expect_parity('<div style="width:300px">text <span style="display:inline-block;width:12px;height:12px;vertical-align:5px"></span> more</div>')
  end
  it 'matches a middle-aligned svg icon in a text line' do
    expect_parity('<div style="width:300px">label <svg viewBox="0 0 16 16" style="height:16px;vertical-align:middle"><path d="M0 0h16v16z"/></svg> here</div>')
  end
  it 'declines a top-aligned atomic (line-box-relative — line height unknown until it closes)' do
    expect_bail('<div style="width:300px">x <span style="display:inline-block;width:10px;height:30px;vertical-align:top"></span> y</div>')
  end
  it 'declines a bottom-aligned atomic (line-box-relative)' do
    expect_bail('<div style="width:300px">x <span style="display:inline-block;width:10px;height:30px;vertical-align:bottom"></span> y</div>')
  end
  it 'declines an absolutely-positioned atomic nested in a span (out of flow)' do
    expect_bail('<div style="position:relative;width:300px">x <b>hi <span style="display:inline-block;position:absolute;width:10px;height:10px"></span></b> y</div>')
  end

  # ── Atomic inlines laid out natively ──────────────────────────────────────────────────────────────────
  # An `inline-block` (a block container inside) or an inline `<img>` at its baseline is native's own: its
  # subtree is a child record of the text block, sized shrink-to-fit (its intrinsic widths clamped to the
  # block's content width; a declared width wins), laid out at that width, and dropped onto its line from its
  # own last baseline (its bottom margin edge when it has no line, or scrolls). A `vertical-align`, an
  # inline-flex / grid / table, or a text-drawing control keeps the pushed box.
  def expect_native_atomic(body, count = 1)
    r = run_shadow(body)
    expect(r).to include('ok' => true), "harness bailed: #{r.inspect}"
    expect(r['mismatches']).to eq(0), "mismatch: #{r.inspect}"
    expect(r['nativeAtomics']).to be >= count, "the atomic was pushed, not laid out natively: #{r.inspect}"
  end

  describe 'native atomic inlines' do
    it 'sizes an inline-block shrink-to-fit and hangs it from its last baseline' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block">inline block text</span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;font-size:32px">big</span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div>line one</div><div>line two</div></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;width:40px">a b c d e f</span> after</div>')
      expect_native_atomic('<div style="width:400px"><span style="display:inline-block"><span style="display:inline-block;width:10px;height:10px"></span> nested</span> x</div>', 2)
    end
    it 'uses the bottom margin edge for an inline-block with no line, or one that scrolls, and for an image' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;width:80px;height:10px"></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;overflow:hidden;height:8px">clipped</span> after</div>')
      expect_native_atomic('<div style="width:400px">text <img> after</div>')
      expect_native_atomic('<div style="width:400px">text <img style="width:30px;margin:4px"> after <img style="height:40px"></div>', 2)
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"></span> empty</div>')
    end
    it 'counts edges and margins on the line, wraps around atomics, and places them on their lines' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;padding:5px;border:2px solid;margin:3px 7px">padded</span> after</div>')
      expect_native_atomic('<div style="width:100px">aaaa aaaa <span style="display:inline-block;width:50px;height:10px"></span> bbbb <span style="display:inline-block;width:50px;height:10px"></span></div>', 2)
      expect_native_atomic('<div style="width:400px;line-height:30px">tall <span style="display:inline-block;height:50px;width:10px"></span> line</div>')
      expect_native_atomic('<div style="width:400px">text <b><span style="display:inline-block;width:10px;height:10px"></span> in bold</b> x</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;position:relative;top:3px;left:4px;width:10px;height:10px"></span> x</div>')
      expect_native_atomic('<div style="width:400px;white-space:nowrap">no wrap <span style="display:inline-block;width:80px;height:10px"></span> here at all in this long line of text that keeps going</div>')
      expect_native_atomic('<div style="width:400px;white-space:pre">pre <span style="display:inline-block;width:80px;height:10px"></span>\nnext</div>')
    end
    it 'keeps the box at its min/max and box-sizing; overflowing content grows neither the box nor the line' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;box-sizing:border-box;width:50px;padding:10px">bb</span> x</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;min-width:150px;max-height:5px"><div style="height:30px"></div></span> x</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div style="height:30px;margin-bottom:-10px"></div></span> x</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;width:40px"><div style="width:100px;height:10px"></div></span> x</div>')
    end
    it 'measures a text block holding atomics for a grid track / flex item, and hangs a baseline through one' do
      expect_native_atomic('<div style="display:grid;grid-template-columns:max-content auto;width:400px"><div>a <span style="display:inline-block">ib text</span> b</div><div>x</div></div>')
      expect_native_atomic('<div style="display:flex;width:400px"><div style="flex:1">text <span style="display:inline-block;width:80px;height:10px"></span> after</div><div>b</div></div>')
      expect_native_atomic('<div style="display:flex;align-items:baseline;width:400px"><div>text <span style="display:inline-block;width:10px;height:30px"></span></div><div style="font-size:32px">BIG</div></div>')
    end
    it 'aligns its lines: center / right / end / rtl move the atomics, an overflowing line hangs off the start edge' do
      ib = 'display:inline-block;width:30px;height:10px'
      %w[center right end].each do |align|
        expect_native_atomic(%(<div style="width:400px;text-align:#{align}">text <span style="#{ib}"></span> after</div>))
        expect_native_atomic(%(<div style="width:100px;text-align:#{align}">aaaa bbbb <span style="#{ib}"></span> cccc dddd <span style="#{ib}"></span><br>x <span style="#{ib}"></span></div>), 3)
        expect_native_atomic(%(<div style="width:60px;text-align:#{align}">a <span style="display:inline-block;width:80px;height:10px"></span> b</div>))
      end
      ['', 'text-align:left', 'text-align:center', 'text-align:end'].each do |align|
        expect_native_atomic(%(<div style="width:400px;direction:rtl;#{align}">text <span style="#{ib}"></span> after</div>))
        expect_native_atomic(%(<div style="width:60px;direction:rtl;#{align}">a <span style="display:inline-block;width:80px;height:10px"></span> b</div>))
      end
      expect_native_atomic(%(<div style="width:100px;text-align:center;white-space:pre-wrap">aaaa <span style="#{ib}"></span>   cccc dddd\n<span style="#{ib}"></span>   </div>), 2)
    end
    it 'keeps the pushed box under justify (the oracle spreads the spaces)' do
      r = run_shadow('<div style="width:100px;text-align:justify">aaa bbb ccc <span style="display:inline-block;width:30px;height:10px"></span> ddd eee fff ggg hhh iii jjj kkk lll</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
    end
    it 'places an atomic on a line shortened by a float' do
      expect_native_atomic('<div style="overflow:hidden;width:400px"><div style="float:left;width:120px;height:60px"></div><div>text <span style="display:inline-block;width:30px;height:10px"></span> after</div></div>')
      expect_native_atomic('<div style="overflow:hidden;width:400px"><div style="float:left;width:120px;height:60px"></div><div style="text-align:center">text <img style="width:30px;height:10px"> after</div></div>')
      expect_native_atomic('<div style="overflow:hidden;width:400px"><div style="float:right;width:120px;height:60px"></div><div style="text-align:right">text <span style="display:inline-block;width:30px;height:10px"></span> after</div></div>')
      expect_native_atomic('<div style="overflow:hidden;width:200px"><div style="float:left;width:120px;height:30px"></div><div>aaaa bbbb cccc <span style="display:inline-block;width:30px;height:10px"></span> dddd eeee ffff gggg hhhh iiii <span style="display:inline-block;width:30px;height:10px"></span></div></div>', 2)
    end
    it 'raises an atomic by its baseline shift, its own or an inline ancestor\'s' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;vertical-align:super">sup</span> y</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;vertical-align:sub"><div>a</div><div>b</div></span> y</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block;vertical-align:0px;width:10px;height:10px"></span> y</div>')
      expect_native_atomic('<div style="width:400px">text <span style="vertical-align:5px">x <span style="display:inline-block;width:10px;height:10px"></span></span> y</div>')
      expect_native_atomic('<div style="width:400px">text <sup>x <span style="display:inline-block;width:10px;height:10px"></span></sup> y</div>')
      expect_native_atomic('<div style="width:400px">text <span style="vertical-align:-8px">x <img style="width:10px;height:10px"></span> y</div>')
      expect_native_atomic('<div style="width:400px">text <span style="vertical-align:4px"><span style="display:inline-block;vertical-align:3px;width:10px;height:10px"></span></span> y</div>')
    end
    it 'hangs an inline-block from a scroll-container child by its margin edge' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div>t</div><div style="overflow:hidden">oh</div></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div>t</div><div style="overflow:hidden;margin-bottom:10px">oh</div></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div>t</div><div style="overflow:hidden">oh</div><div style="height:5px"></div></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div style="overflow:hidden">oh</div><div>t</div></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div><div style="overflow:auto;height:30px">deep</div></div></span> after</div>')
    end
    it 'hangs an inline-block from a block-level control child by its font baseline' do
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><input style="display:block"></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><input style="display:block;margin-bottom:10px"></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><input style="display:block;padding:10px 2px"></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><input style="display:block;height:40px"></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><div>t</div><input style="display:block"></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><textarea style="display:block;margin-bottom:6px"></textarea></span> after</div>')
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><img style="display:block;width:30px;height:30px"></span> after</div>')
      # A control that lays out CSS-box children of its own (a list-box `<select>` stacking its options) is no
      # leaf: it reads its baseline off those lines, as any block does, and the walk declines it — so the atomic
      # around it keeps the pushed box.
      r = run_shadow('<div style="width:400px">text <span style="display:inline-block"><select multiple style="display:block"><option>a</option></select></span> after</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
    end
    it 'declines a text block whose atomic needs the pushed box inside a subtree native MEASURES' do
      # A pushed atomic's box is not in the run stream `text_intrinsic` reads, so it may only sit in a text block
      # whose intrinsic widths native never asks for: a nested atomic, a grid intrinsic track's item, a natively
      # sized flex item or a shrink-to-fit out-of-flow box declines the whole pass instead (the oracle lays it
      # out). A FLOAT and a STRETCHED out-of-flow box are sized without an intrinsic measure, so they push.
      ib = 'display:inline-block;margin:0 auto'
      expect_bail(%(<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a <span style="#{ib}">in</span> b</div><div>x</div></div>))
      expect_bail(%(<div style="display:flex;width:100px"><div>a <span style="#{ib}">in</span> b</div><div style="flex:1">x</div></div>))
      expect_bail(%(<div style="width:400px;position:relative"><div style="position:absolute;left:0">a <span style="#{ib}">in</span> b</div><p>x</p></div>))
      [
        %(<div style="overflow:hidden;width:400px"><div style="float:left;width:200px">f <span style="display:inline-block">a <span style="#{ib}">x</span> b</span> g</div></div>),
        %(<div style="width:400px;position:relative"><div style="position:absolute;left:0;right:100px">a <span style="#{ib}">in</span> b</div><p>x</p></div>),
        %(<div style="display:grid;grid-template-columns:100px 200px;width:400px"><div>a <span style="#{ib}">in</span> b</div><div>x</div></div>)
      ].each do |body|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{body}: #{r.inspect}"
      end
      # A MIXED block wraps its inline content in ANONYMOUS blocks, whose atomics are all pushed (they have no
      # record to hang a subtree on), so an atomic makes a block with any block-level child unmeasurable too.
      mixed = '<div><div>blk</div>p <span style="display:inline-block">ok</span> q</div>'
      [
        %(<div style="width:400px;position:relative"><div style="position:absolute;left:0;top:0">#{mixed}</div><p>x</p></div>),
        %(<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>#{mixed}</div><div>x</div></div>),
        %(<div style="display:flex;width:300px"><div>#{mixed}</div><div style="flex:1">x</div></div>),
        %(<div style="width:400px">a <span style="display:inline-block">#{mixed}</span> b</div>),
        %(<div style="width:400px">#{mixed}</div>)
      ].each do |body|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{body}: #{r.inspect}"
      end
      # …and each of those still lays out an atomic it CAN walk.
      expect_native_atomic(%(<div style="overflow:hidden;width:400px"><div style="float:left;width:200px">f <span style="display:inline-block">ok</span> g</div></div>))
      expect_native_atomic(%(<div style="width:400px;position:relative"><div style="position:absolute;left:0;right:100px">a <span style="display:inline-block">in</span> b</div><p>x</p></div>))
      # …while a text block native only LAYS OUT keeps the pushed box: the decline cascades up to the outermost
      # atomic, whose own text block is not measured, and THAT atomic is pushed whole.
      r = run_shadow(%(<div style="width:400px">a <span style="display:inline-block">a <span style="#{ib}">in</span> b</span> c</div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
      expect_native_atomic('<div style="width:400px">a <span style="display:inline-block"><div style="position:relative">t <span style="display:inline-block">ok</span></div></span> c</div>', 2)
    end
    it 'rolls a declined subtree back off the record stream and pushes its box' do
      [
        '<div style="width:400px">text <span style="display:inline-block"><div style="position:absolute;width:10px;height:10px"></div>ib</span> after</div>',
        '<div style="width:400px">text <span style="display:inline-block"><div style="float:left;width:10px;height:10px"></div>beside</span> after</div>',
        '<div style="width:400px">text <span style="display:inline-block">日本語</span> after</div>',
        "<div style=\"width:400px\">text <span style=\"display:inline-block;white-space:pre\">a\tb</span> after</div>",
        '<div style="width:400px">text <span style="display:inline-block;margin:0 auto;width:20px;height:10px"></span> after</div>'
      ].each do |body|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{body}: #{r.inspect}"
      end
      expect_native_atomic('<div style="width:400px"><span style="display:inline-block">ok</span> and <span style="display:inline-block"><div style="float:left;width:10px;height:10px"></div>beside</span> after</div>', 1)
    end
    it 'keeps the pushed box for a font-box-aligned atomic, an inline-flex, and a control' do
      r = run_shadow('<div style="width:400px">text <span style="display:inline-block;vertical-align:middle;width:10px;height:30px"></span> x</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
      r = run_shadow('<div style="width:400px">text <span style="display:inline-flex"><div>f</div></span> x</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
      r = run_shadow('<div style="width:400px">text <input> after</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
    end
  end
end
