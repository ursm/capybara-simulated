# frozen_string_literal: true
# Native layout — INLINE ATOMICS, geometry shadow-parity. An atomic inline is a single box on a line. Native
# lays out an `inline-block`, an `inline-flex` / `inline-grid` / `inline-table` (its own container, at that
# container's own shrink-to-fit) and every INLINE REPLACED element — an `<img>` / `<svg>` / `<canvas>`, a form
# control, a list box whose rows it stacks inside the control's box — at its baseline or a baseline SHIFT,
# ITSELF (see the last describe). What still keeps the PUSHED box, each measured: an intrinsic-size KEYWORD
# width on a replaced atomic (`width: fit-content` on an `<img>`); an `inline-grid` over bare text, whose
# anonymous item neither engine gives a record; an inline-table whose row GROUPS render out of document order;
# and any atomic whose own subtree the walk refuses, which rolls back to the pushed box.
# For a pushed one the oracle resolved the box (`_lb`) and its baseline (`growAtomic`) and native replays those
# as a RUN_ATOMIC: the margin-box width is its advance, its ascent (+ descent) grow the line box. Such a box is
# not compared (like every inline fragment in a text block); what's validated is the text block's line-broken
# HEIGHT — which is why a shape that has to prove the atomic is LAID OUT asserts `nativeAtomics` or the
# no-oracle read set instead. V8 only.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'native layout inline-atomic parity', if: ENV.fetch('CSIM_JS_ENGINE', 'v8') == 'v8' do
  def page(body)
    # The charset is declared: served without one, a fixture's UTF-8 bytes decode as windows-1252 and the
    # example tests mojibake instead of what it reads as (this file's `\u65E5\u672C\u8A9E` fixture was really
    # testing an em dash, and passed for the wrong reason).
    html = %(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)
    Rack::Builder.new { run ->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] } }.to_app
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

  # …and the page-visible x of one element, for the cases where parity is not the whole question: a rule BOTH
  # engines share is exactly what parity cannot see, so the Chrome-measured number is pinned beside it.
  def rendered_x(body, selector)
    rendered_rect(body, selector)['x']
  end

  def rendered_width(body, selector)
    rendered_rect(body, selector)['width']
  end

  def rendered_rect(body, selector)
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script(%(JSON.parse(JSON.stringify(document.querySelector('#{selector}').getBoundingClientRect()))))
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
  # the shift on its run; the Rust line layout grows the line box around it either way. `top` / `bottom` are
  # the other family — they align to the LINE box itself, whose height is not known until it closes — and are
  # resolved at the close instead; see the examples below them.
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
  # `top` / `bottom` are the other family: they hang from the LINE BOX, which does not know its own height
  # until every run on it is placed, so such a box gives the line no ascent and no descent — only a height it
  # has to reach — and is placed at the close. Both engines resolve it the same way, and the rule is not "how
  # tall" but WHICH EDGE MOVES: the line grows away from whichever family asked for the most room.
  #
  # Every example here carries baseline-aligned boxes beside the subject, and that is not decoration: a `top`
  # box sits at the line's top whatever the line's ascent is, so its own geometry is right even when the
  # ascent is wrong. Only something baseline-aligned on the same line can see the difference, and a text run
  # is not a compared box. Measured on the `valine` sweep with an ascent-only bug injected into the grow rule:
  # 536 mismatches with the marker boxes, 80 without.
  #
  # …but NOT this file's 60px `MARKER`, and that distinction is the whole reason these markers are declared
  # here. A marker taller than the subject makes the line taller than anything the subject could ask for, so
  # `line_outer_min` never exceeds the line and the grow rule is never ENTERED — the examples then pin only
  # the placement, and the family rule below has no test at all. (Measured: with the 60px marker, an
  # ascent-only bug in the grow rule leaves every native-layout example green — and the oracle's own
  # `layout_vertical_align_spec` with them, since the oracle is what the page geometry still comes from.)
  # These are sized to LOSE to the subject, which is what puts the line's height in its hands.
  VA_MARKS = '<span style="display:inline-block;width:3px;height:6px"></span>' \
             '<span style="display:inline-block;width:4px;height:14px"></span>'
  VA_TOP = ->(h) { %(<span style="display:inline-block;width:10px;height:#{h}px;vertical-align:top"></span>) }
  VA_BOT = ->(h) { %(<span style="display:inline-block;width:10px;height:#{h}px;vertical-align:bottom"></span>) }

  it 'places a top-aligned atomic against the line box' do
    expect_parity(%(<div style="width:300px">x #{VA_MARKS}#{VA_TOP.call(30)} y</div>))
  end
  it 'places a bottom-aligned atomic against the line box' do
    expect_parity(%(<div style="width:300px">x #{VA_MARKS}#{VA_BOT.call(30)} y</div>))
  end
  it 'grows the line away from whichever of the two families asks for the most room' do
    # A 40px `top` beside a 30px `bottom` keeps the baseline where it was and takes the line to 40; the same
    # pair the other way round moves the ASCENT instead, and the 6px marker drops from 8 to 30. Both arms of
    # that `if`, and the tie between them.
    [[40, 30], [30, 40], [40, 40]].each do |a, b|
      expect_parity(%(<div style="width:300px">x #{VA_MARKS}#{VA_TOP.call(a)}#{VA_BOT.call(b)} y</div>))
    end
    # …and a line-relative box SHORTER than the line asks for nothing at all: the grow is not entered, which
    # is the case the 60px marker turns every other example into.
    expect_parity(%(<div style="width:300px;line-height:50px">x #{VA_MARKS}#{VA_TOP.call(8)}#{VA_BOT.call(6)} y</div>))
  end
  # An atomic that is OUT OF FLOW is no atomic at all: it takes no room on the line, and what the line gives it
  # is its STATIC POSITION — the marker the run stream carries, settled where the flow had reached (see the
  # block spec's `a static position taken off a line`). Nested inlines included.
  it 'lays out an absolutely-positioned atomic nested in a span as an out-of-flow box' do
    r = run_shadow('<div style="position:relative;width:300px">x <b>hi <span style="display:inline-block;position:absolute;width:10px;height:10px"></span></b> y</div>')
    # …POSITIONED natively, not replayed: `expect_parity` alone would pass on the oracle's own box.
    expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeOutOfFlow' => 1), r.inspect
    expect(r['compared']).to be > 0, "nothing was compared: #{r.inspect}"
  end

  # ── Atomic inlines laid out natively ──────────────────────────────────────────────────────────────────
  # An atomic native lays out itself: its subtree is a child record of the text block, sized shrink-to-fit (its
  # intrinsic widths clamped to the block's content width; a declared width wins) or — a REPLACED one — from the
  # intrinsic size on its record, laid out at that width, and dropped onto its line from its own last baseline
  # (its bottom margin edge when it has no line, or scrolls; a text-drawing control's font baseline). What still
  # keeps the PUSHED box is listed at the top of this file.
  # `count` is a MINIMUM, so it has to be the number of atomics the shape really holds: a marker box put on
  # the line to make the atomic's baseline observable is itself an atomic, and a count of 1 is then satisfied
  # by the marker alone — the example passes with the subject still pushed.
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
      expect_native_atomic(%(<div style="width:400px;white-space:pre">pre <span style="display:inline-block;width:80px;height:10px"></span>\nnext</div>))
    end
    # A `position: relative` INLINE offsets its whole fragment at paint time (§9.4.3), the atomic inlines on its
    # lines included — and the inline boxes themselves have no records, so the atomic's own box is where that
    # shift lands. Nested relative inlines add per axis, and so does the atomic's own offset.
    it 'offsets an atomic by the position:relative of the inlines above it' do
      ib = 'display:inline-block;width:20px;height:20px'
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:30px;top:7px"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:30px"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;top:7px"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:30px;top:7px">t <span style="#{ib}"></span> u</span> v</div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:30px"><b style="position:relative;top:4px"><span style="#{ib}"></span></b></span></div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:30px;top:7px"><img style="width:20px;height:20px"></span></div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:-10px;top:-4px"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;right:10px;bottom:4px"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px;height:100px">a <span style="position:relative;left:10%;top:10%"><span style="#{ib};position:relative;top:5px"></span></span></div>))
      # A fragment that WRAPS carries its offset onto both lines.
      expect_native_atomic(%(<div style="width:120px">aaa bbb ccc <span style="position:relative;left:8px;top:3px"><span style="#{ib}"></span> ddd eee <span style="#{ib}"></span></span> fff</div>), 2)
      # An atomic's OWN inline formatting context is a different fragment: the outer offset reaches it once,
      # through the atomic it sits in, never twice.
      expect_native_atomic(%(<div style="width:200px;height:100px">a <span style="position:relative;top:10%"><span style="display:inline-block;width:60px">x <span style="position:relative;top:10%"><span style="#{ib}"></span></span></span></span></div>), 2)
      # …one aligned against the parent's font box takes the offset the same way
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;left:30px;top:7px"><span style="#{ib};vertical-align:middle"></span></span></div>))
      # A PUSHED atomic already carries the oracle's offset — the shift must not be added to it
      # a second time.
      table = '<span style="display:inline-block"><div style="display:table-cell">c</div></span>'
      r = run_shadow(%(<div style="width:200px">a <span style="position:relative;left:30px;top:7px">#{table}</span></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
    end
    # A PERCENTAGE inset resolves against the containing block of the fragment — both axes, which needs the pair
    # `placeInlineBox` stamps on a fragmented inline (it has no box of its own to read one off). An auto-height
    # block gives no vertical basis, so a `%` there is 0 (Chrome).
    it 'resolves a percentage offset on the inline above it, on both axes' do
      ib = 'display:inline-block;width:20px;height:20px'
      expect_native_atomic(%(<div style="width:200px;height:100px">a <span style="position:relative;top:10%"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px;height:100px">a <span style="position:relative;bottom:10%"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px;height:100px">a <span style="position:relative;left:10%"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px;height:200px"><div style="height:50%">a <span style="position:relative;top:10%"><span style="#{ib}"></span></span></div></div>))
      expect_native_atomic(%(<table style="width:200px"><tr><td style="height:60px">a <span style="position:relative;top:10%;left:10%"><span style="#{ib}"></span></span></td></tr></table>))
      expect_native_atomic(%(<div style="width:200px">a <span style="position:relative;top:50%"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px;min-height:80px">a <span style="position:relative;top:50%"><span style="#{ib}"></span></span></div>))
      expect_native_atomic(%(<div style="width:200px;height:100px">a <span style="position:relative;top:10%"><span style="position:relative;top:10%"><span style="#{ib}"></span></span></span></div>))
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
    # `justify` used to push every atomic's box: native holds no per-space positions, the argument went. It holds
    # the GAPS now — each space's origin on the line — and spreads a wrapped line's free space over the ones
    # before its content ends, so an atomic on such a line is laid out like any other.
    it 'lays out an atomic on a justified line' do
      expect_native_atomic('<div style="width:100px;text-align:justify">aaa bbb ccc <span style="display:inline-block;width:30px;height:10px"></span> ddd eee fff ggg hhh iii jjj kkk lll</div>')
      expect_native_atomic('<div style="width:200px;text-align:justify;direction:rtl">aaa bbb ccc <span style="display:inline-block;width:30px;height:10px"></span> ddd eee fff ggg hhh</div>')
      expect_native_atomic('<div style="width:120px;text-align:justify;white-space:pre-wrap;font:16px monospace">aa bb <span style="display:inline-block;width:20px;height:8px"></span> cc dd ee</div>')
      expect_native_atomic('<div style="width:160px;text-align:justify;text-indent:20px">aaa bbb ccc <span style="display:inline-block;width:30px;height:10px"></span> ddd eee fff ggg</div>')
      # …the LAST line and one a `<br>` ends keep their natural spacing (§7.1), which is the same arithmetic
      expect_native_atomic('<div style="width:200px;text-align:justify">aaa <span style="display:inline-block;width:30px;height:10px"></span> bbb<br>ccc</div>')
      # …and the gap SOURCES that are not an ordinary space, each crossed with the box that measures them: a
      # NO-BREAK SPACE is a gap (§8.1, Chrome widens it) though it breaks nothing, and the separators a
      # non-wrapping run ENDS in are held back until something follows them on the line.
      ib = '<span style="display:inline-block;width:20px;height:8px"></span>'
      [%(xx aa&nbsp;bb #{ib} yy cc dd ee ff gg hh ii jj kk ll mm nn oo pp),
       %(xx aa&nbsp;&nbsp;bb #{ib} yy cc dd ee ff gg hh ii jj kk ll mm nn),
       %(xx aa <span style="white-space:nowrap">bb&nbsp;cc</span> #{ib} yy dd ee ff gg hh ii),
       %(xx #{ib} yy <span style="white-space:pre">aa bb </span> cccccccccccccccc zz ff gg hh ii jj kk ll),
       %(xx #{ib} yy <span style="white-space:pre">aa	bb	</span> cccccccccccccccc zz ff gg hh ii jj)].each do |content|
        expect_native_atomic(%(<div style="width:180px;text-align:justify">#{content}</div>))
      end
    end
    # …and WHICH SPACES are gaps at all is a question about what the space IS, not about what it measures.
    # Native asked the WIDTH at every one of them — eight readers across five sites — and a zero-advance
    # pending space is normally the break OPPORTUNITY a
    # `pre` (or `nowrap`) run leaves behind, and no separator — so a real space whose advance cancelled to
    # zero fell through the same door: it took every gap on the line with it, broke a line in two where both
    # engines said one, and kept a preserved run alive past the space that ends it. The oracle has no width
    # test anywhere here; what it mirrors is "a collapsible space was PLACED", whatever it measured.
    # (The first fix converted four of the eight. A diff cannot show "applied everywhere" — the count is here
    # so the next reader can check it against the code rather than against the change that last touched it.)
    #
    # Asserted as a RELATION to the text's own advance rather than against a pixel figure, because the shape
    # is 16px monospace and a bare number is a font metric in disguise — the face CI resolves is not the one
    # measured here. What the rule says is: a separator takes a share of the free space and an opportunity
    # does not. (Chrome at a 9.6px advance: 25.266 and 19.203.) The `sep` bit's two FALSE producers are
    # guarded by the `justify` sweep, not here — mutating them to true takes it from 0 to 766 mismatches.
    it 'gives a share to a separator whose advance cancels to zero, and none to a zero-width opportunity' do
      atom = '<span id="t" style="display:inline-block;width:10px;height:8px"></span>'
      line = ->(lead, style) { %(<div style="width:200px;text-align:justify;font:16px monospace;#{style}">aa#{lead}#{atom} bb cc dd eeee ffff gggg hhhh iiii jjjj</div>) }
      # `aa` is the whole of the line before the atomic in every shape below, so its width is where the atomic
      # would sit with no share at all — and for the `&#8203;` shape that also asserts the resolved face gives
      # U+200B no advance, which is a font-table fact riding along rather than a layout one.
      # …and it is the ORACLE's geometry, so the pixel relations below hold at HEAD too: what fails there is
      # `expect_native_atomic`. These examples are a parity guard first, and a guard on the shared rule —
      # which parity cannot see — second.
      unshifted = rendered_width('<span id="t" style="font:16px monospace">aa</span>', '#t')

      cancelled = line.call(' ', 'word-spacing:-9.6px')
      expect_native_atomic(cancelled)
      expect(rendered_x(cancelled, '#t')).to be > unshifted + 1
      # …a knife edge on the advance, not a range: either side of it is an ordinary separator.
      ['word-spacing:-9.59px', 'word-spacing:-9.61px'].each {|style| expect_native_atomic(line.call(' ', style)) }

      # …while a zero-width OPPORTUNITY is no separator however the line is justified: the atomic sits exactly
      # where the text leaves it. (These two reach neither `sep` producer — U+200B queues no pending space and
      # `<wbr>` only rewrites one — so they pin the boundary rather than the bit.)
      ['&#8203;', '<wbr>'].each do |opp|
        body = line.call(opp, '')
        expect_native_atomic(body)
        expect(rendered_x(body, '#t')).to be_within(0.01).of(unshifted)
      end
    end
    # …and a gap that sits EXACTLY at the line's END is either cut as hanging or kept and widened, which is a
    # whole gap's share of the free space — decided, until now, on the last bit of two sums the two engines
    # accumulate in different orders. That is the coincidence `LINE_FIT_EPS` was written for, never applied to
    # this comparison. The first shape lands on it: a `white-space: pre` run's SINGLE trailing space, then a
    # collapsible one, then the atomic, at a width where native's following gap came out 125.59999999999998
    # against an end of 125.6 — its atomic at 133.12 where this engine and Chrome both say 140.
    #
    # **Parity cannot police the tolerance itself**: both engines share it, and a shared error is what parity
    # is blind to by construction. So each shape carries CHROME's number too, which is the only instrument
    # that would catch one wide enough to swallow a real gap. (A gap's origin is its space's START, so the
    # least separation between a non-hanging gap and the line's end is that space's own advance — 9.6px here.
    # There is ten orders of magnitude between that and the tolerance, and no layout can close it.)
    it 'gives a gap that ends the line no share of the free space' do
      line = ->(pre) { %(<div style="width:160px;text-align:justify;font:16px monospace">aaa <span style="white-space:pre">#{pre}</span> <span id="t" style="display:inline-block;width:20px;height:8px"></span> ddd eee fff ggg hhh iii jjj</div>) }
      # 140 is not a font figure but a structural one — 160 − 20, the atomic flush at the content edge,
      # because it ENDS the line. That holds for any monospace advance in (9.33, 12.72]; outside it " ddd"
      # joins the line and the answer is something else, so `be_within` rather than an exact float and this
      # note rather than a bare number.
      {'bb cc ' => 140, 'bb cc  ' => 140, 'bb cc' => 100.203125}.each do |pre, chrome|
        expect_native_atomic(line.call(pre))
        expect(rendered_x(line.call(pre), '#t')).to be_within(0.05).of(chrome)
      end
    end
    # …and how far a box on such a line moves is a question about ORDER — how many widened gaps PRECEDE it —
    # which both engines answered by comparing COORDINATES. Two declarations carry a box across a gap boundary
    # without changing which gaps come before it, and each bought it a whole extra increment: its own negative
    # horizontal margin and its §9.4.3 `position: relative` offset. Native had the mirror bug at the other end
    # — an atomic that OPENS the line with a negative margin counted the gap AFTER it. Both count at placement
    # now. Adding this axis to the `justify` sweep took it from 530 mismatches to 0, all of them pre-existing:
    # its compared box had never carried an offset of its own.
    #
    # Asserted as the DELTA from the no-offset twin, which is what Chrome pins — our text advances put the
    # unshifted box at 88.160 against Chrome's 88.453.
    it 'moves an atomic on a justified line by the gaps before it, not by where its box sits' do
      at = ->(decl, align = 'justify') {
        body = %(<div style="width:181px;text-align:#{align}">aaa bbb ccc ) +
               %(<span id="t" style="display:inline-block;width:10px;height:6px;#{decl}"></span> ddd eee fff ggg hhh iii</div>)
        expect_native_atomic(body)
        session = simulated_session(page(body))
        session.visit '/'
        session.evaluate_script(%(document.getElementById('t').getBoundingClientRect().x))
      }
      base = at.call('')
      # …and the line really IS justified: the `text-align: left` twin puts the same box 9.55px to the left
      # (Chrome 78.609 against 88.453). Without this the example passes having tested nothing the day the text
      # stops wrapping.
      expect(at.call('', 'left')).to be < base - 5
      # A `position: relative` offset moves the box and nothing else, so its delta IS the offset (Chrome
      # 88.453 -> 93.453 for `left: 5px`). A MARGIN also changes the line's free space, so its delta is the
      # margin plus what the redistribution gives back — those three figures are Chrome's too (92.453 /
      # 85.453 / 76.453), and ours match them exactly. The 0.1px row is OURS: Chrome quantises a sub-pixel
      # offset to 1/64px and reports +0.09375, so what it pins is only that a sub-gap offset buys no gap.
      {'position:relative;left:0.1px'        =>   0.1,
       'position:relative;left:5px'          =>   5,
       'position:relative;left:40px'         =>  40,
       'position:relative;left:-5px'         =>  -5,
       'margin-left:8px'                     =>   4,
       'margin-left:-6px'                    =>  -3,
       'padding-left:12px;margin-left:-12px' => -12}.each do |decl, delta|
        expect(at.call(decl)).to be_within(0.001).of(base + delta), decl
      end
      # …and one that OPENS the line, where native counted the gap that follows it instead (Chrome -12).
      opener = %(<div style="width:181px;text-align:justify"><span id="t" style="display:inline-block;) +
               %(margin-left:-12px;width:10px;height:6px"></span> aaa bbb ccc ddd eee fff ggg hhh iii</div>)
      expect_native_atomic(opener)
      session = simulated_session(page(opener))
      session.visit '/'
      expect(session.evaluate_script(%(document.getElementById('t').getBoundingClientRect().x))).to be_within(0.001).of(-12)
    end

    it 'places an atomic on a line shortened by a float' do
      expect_native_atomic('<div style="overflow:hidden;width:400px"><div style="float:left;width:120px;height:60px"></div><div>text <span style="display:inline-block;width:30px;height:10px"></span> after</div></div>')
      expect_native_atomic('<div style="overflow:hidden;width:400px"><div style="float:left;width:120px;height:60px"></div><div style="text-align:center">text <img style="width:30px;height:10px"> after</div></div>')
      expect_native_atomic('<div style="overflow:hidden;width:400px"><div style="float:right;width:120px;height:60px"></div><div style="text-align:right">text <span style="display:inline-block;width:30px;height:10px"></span> after</div></div>')
      expect_native_atomic('<div style="overflow:hidden;width:200px"><div style="float:left;width:120px;height:30px"></div><div>aaaa bbbb cccc <span style="display:inline-block;width:30px;height:10px"></span> dddd eeee ffff gggg hhhh iiii <span style="display:inline-block;width:30px;height:10px"></span></div></div>', 2)
    end
    # A block holding block children AND inline content wraps each run of the inline content in an anonymous
    # block, whose lines are laid out like any text block's — atomics included. They used to be pushed there
    # unconditionally, the anonymous record having no index yet for a subtree to hang under: the oracle's box and
    # baseline, read off `_lb`, for every inline-block beside a block sibling.
    it 'lays out an atomic on the lines of an anonymous block beside block siblings' do
      ib = 'display:inline-block;width:30px;height:10px'
      expect_native_atomic(%(<div style="width:400px">text <span style="#{ib}"></span> after<div>block</div></div>))
      expect_native_atomic(%(<div style="width:400px"><div>block</div>a <span style="#{ib}"></span><p>para</p><span style="display:inline-block">b c</span> d</div>), 2)
      expect_native_atomic(%(<div style="width:400px;text-align:center;direction:rtl"><div>block</div>a <b style="position:relative;top:3px">b <span style="#{ib};vertical-align:4px"></span></b></div>))
      expect_native_atomic(%(<div style="width:90px"><div>block</div>aaa bbb <img style="width:40px;height:20px"> ccc <span style="#{ib}"></span> ddd</div>), 2)
      # …inside a subtree native MEASURES, too: the anonymous block is part of the inline-block's shrink-to-fit
      expect_native_atomic(%(<div style="width:400px">x <span style="display:inline-block"><div>block</div>text <span style="#{ib}"></span></span> y</div>), 2)
      # …and a whitespace-only group still collapses to nothing, taking no record with it
      expect_parity(%(<div style="width:400px"><div>one</div> <span></span> <div>two</div></div>))
      # …an atomic native still cannot lay out, in a group a flex row MEASURES, takes the row's fallback rather
      # than a pushed box the measure cannot see
      tbl = '<span style="display:inline-block"><div style="display:table-cell">c</div></span>'
      r = run_shadow(%(<div style="display:flex;width:300px"><div>x <span style="display:inline-block"><div>b</div>t #{tbl}</span></div><div style="flex:1">y</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeFlexRows' => 0), r.inspect
      # …and a JUSTIFIED group's atomics are native too, its lines spread the way a text block's are
      expect_native_atomic(%(<div style="width:100px;text-align:justify"><div>block</div>aaa bbb ccc <span style="#{ib}"></span> ddd eee fff ggg</div>))
    end
    it 'reads no oracle box for an atomic on an anonymous block\'s lines' do
      session = simulated_session(page('<div style="width:400px">text <span style="display:inline-block;width:30px;height:10px"></span> after<div>block</div></div>'))
      session.visit '/'
      session.evaluate_script('document.body.offsetHeight')
      r = session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
      expect(r).to include('ok' => true, 'mismatches' => 0)
      expect(r['oracleReads'].keys.grep(/\AnlGatherRuns |\AatomicBaselineOffset |\AboxBaselineOffset /)).to eq([])
    end
    # An INLINE replaced element — `<svg>` / `<canvas>` by their own UA display, every form control forced to
    # `display: inline`. The arm that decided this admitted only an `<img>`, because when it was written a
    # text-drawing control's baseline was still the oracle's; `controlBaseline` made it native's soon after and
    # the arm was never re-asked, so every other inline replaced element stayed a PUSHED atomic carrying the
    # oracle's box and ascent. Parity cannot see that — a replayed box agrees with the oracle by construction —
    # so these assert `nativeAtomics` and the no-oracle read set, not just the geometry. A 25,760-case sweep
    # crossing element x `vertical-align` x own box x line context: oracle-free 1632 -> 18768, 0 mismatches.
    it 'lays out an inline replaced element as an atomic, control chrome and all' do
      ['<svg width="20" height="25"></svg>',
       '<canvas width="20" height="25"></canvas>',
       '<input style="display:inline">',
       '<input type="checkbox" style="display:inline">',
       '<textarea style="display:inline">hi</textarea>',
       '<select style="display:inline"><option>aa</option></select>',
       '<progress style="display:inline"></progress>'].each do |el|
        expect_native_atomic(%(<div style="width:400px">text #{el} after</div>))
      end
      # …a LIST BOX too, whose box is the control's and whose rows native stacks inside it — the one replaced
      # element that is not a leaf.
      expect_native_atomic(%(<div style="width:400px">text <select multiple size="3" style="display:inline">) +
                           %(<option>a</option><option>bb</option></select> after</div>))
    end
    # …and it needs NONE of the oracle's figures, which is the whole point of laying it out rather than pushing
    # it: the read set is the one figure the harness hands the pass.
    it 'reads no oracle box for an inline replaced atomic' do
      ['<div style="width:400px">before <svg width="30" height="20"></svg> after</div>',
       '<div style="width:400px">before <input style="display:inline;vertical-align:super"> after</div>',
       '<div style="width:60px">text <select style="display:inline"><option>aa</option></select> wraps here</div>'].each do |body|
        session = simulated_session(page(body))
        session.visit '/'
        session.evaluate_script('document.body.offsetHeight')
        r = session.evaluate_script('globalThis.__csimLayoutShadowRun(undefined, {noOracle: true})')
        expect(r).to include('ok' => true, 'mismatches' => 0, 'oracleWrites' => 0), r.inspect
        expect(r['oracleReads'].keys).to eq(['nlShadowRun the pass root origin and width (handed over)']), body
      end
    end
    # …and a LINE-relative `vertical-align` is native's too, on an inline replaced element as on every other
    # atomic: the run carries the mode and the line close resolves it.
    it 'places a line-relative inline replaced element against the line box' do
      expect_parity(%(<div style="width:400px">text #{VA_MARKS}<input style="display:inline;vertical-align:top"> after</div>))
      expect_parity(%(<div style="width:400px">text #{VA_MARKS}<svg width="20" height="25" style="vertical-align:bottom"></svg> after</div>))
      # …and one nested in an inline, which is where the WIDTH gate that used to refuse it lives: the whole
      # pass declined for it under any shrink-to-fit asker, long after the alignment itself went native.
      expect_parity(%(<div style="width:fit-content">ab #{VA_MARKS}<span style="padding:0 3px">x <img width="20" height="40" style="vertical-align:top"> y</span> cd</div>))
      expect_parity(%(<div style="width:400px"><div style="float:left">ab #{VA_MARKS}<span>x <img width="20" height="40" style="vertical-align:bottom"> y</span></div><div style="height:9px"></div></div>))
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
      # A LIST BOX showing rows is NOT a leaf: its BOX is the control's (the intrinsic data, `lays_out_children`)
      # and native stacks its options inside it, so the inline-block around one is a native atomic like any other.
      expect_native_atomic('<div style="width:400px">text <span style="display:inline-block"><select multiple style="display:block"><option>a</option></select></span> after</div>')
    end
    it 'keeps the pushed box by NOT measuring the subtree it sits in' do
      # A pushed atomic's box is not in the run stream `text_intrinsic` reads, so it may only sit in a text block
      # whose intrinsic widths native never asks for. That is decided BEFORE the walk: `nlAtomicMeasurable`
      # answers what the walk will DO with the atomic, so a container that would have measured such a subtree
      # takes its own fallback instead — a grid intrinsic track and a flex item use the oracle's contribution, a
      # shrink-to-fit out-of-flow box keeps the oracle's box, an outer atomic is pushed whole — and the pass is
      # laid out with the atomic pushed rather than declined. (A FLOAT and a STRETCHED out-of-flow box never
      # needed a measure at all.) The one route with no fallback is a vertical writing mode's block child, whose
      # width IS its content's: that still declines.
      ib = 'display:inline-grid'   # …over BARE text, an anonymous grid item neither engine gives a record
      expect_bail(%(<div style="width:400px"><div style="writing-mode:vertical-lr">a <span style="#{ib}">in</span> b</div></div>))
      # Each route with the atomic it cannot lay out, and the SAME shape with one it can — so the counter shows
      # the fallback was taken here and is not simply never taken.
      [
        ['nativeIntrinsicGrids', %(<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>a <span style="%s">in</span> b</div><div>x</div></div>)],
        ['nativeFlexRows',       %(<div style="display:flex;width:100px"><div>a <span style="%s">in</span> b</div><div style="flex:1">x</div></div>)],
        ['nativeOutOfFlow',      %(<div style="width:400px;position:relative"><div style="position:absolute;left:0">a <span style="%s">in</span> b</div><p>x</p></div>)]
      ].each do |counter, shape|
        fallback = run_shadow(shape.sub('%s', ib))
        expect(fallback).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{shape}: #{fallback.inspect}"
        expect(fallback[counter]).to eq(0), "#{counter} should have fallen back: #{fallback.inspect}"
        measured = run_shadow(shape.sub('%s', 'display:inline-block'))
        expect(measured).to include('ok' => true, 'mismatches' => 0), "#{shape}: #{measured.inspect}"
        expect(measured[counter]).to be >= 1, "#{counter} never measures, so the fallback pins nothing: #{measured.inspect}"
      end
      [
        %(<div style="width:400px">x <span style="display:inline-block">a <span style="#{ib}">in</span> b</span></div>),
        %(<div style="overflow:hidden;width:400px"><div style="float:left;width:200px">f <span style="display:inline-block">a <span style="#{ib}">x</span> b</span> g</div></div>),
        %(<div style="width:400px;position:relative"><div style="position:absolute;left:0;right:100px">a <span style="#{ib}">in</span> b</div><p>x</p></div>),
        %(<div style="display:grid;grid-template-columns:100px 200px;width:400px"><div>a <span style="#{ib}">in</span> b</div><div>x</div></div>)
      ].each do |body|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{body}: #{r.inspect}"
      end
      # A MIXED block wraps its inline content in ANONYMOUS blocks, whose atomics are laid out like a text block's
      # — so an atomic there leaves every one of those routes measuring, and the atomic is native.
      mixed = '<div><div>blk</div>p <span style="display:inline-block">ok</span> q</div>'
      [
        [%(<div style="width:400px;position:relative"><div style="position:absolute;left:0;top:0">#{mixed}</div><p>x</p></div>), 'nativeOutOfFlow'],
        [%(<div style="display:grid;grid-template-columns:min-content auto;width:400px"><div>#{mixed}</div><div>x</div></div>), 'nativeIntrinsicGrids'],
        [%(<div style="display:flex;width:300px"><div>#{mixed}</div><div style="flex:1">x</div></div>), 'nativeFlexRows'],
        [%(<div style="width:400px">a <span style="display:inline-block">#{mixed}</span> b</div>), 'nativeAtomics'],
        [%(<div style="width:400px">#{mixed}</div>), 'nativeAtomics']
      ].each do |body, counter|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0), "#{body}: #{r.inspect}"
        expect(r['nativeAtomics']).to be >= 1, "#{body}: #{r.inspect}"
        expect(r[counter]).to be >= 1, "#{counter} fell back: #{r.inspect}"
      end
      # …a JUSTIFIED mixed block included, now that a justified line is native's to spread
      justified = '<div style="text-align:justify"><div>blk</div>p <span style="display:inline-block">ok</span> q</div>'
      r = run_shadow(%(<div style="display:flex;width:300px"><div>#{justified}</div><div style="flex:1">x</div></div>))
      expect(r).to include('ok' => true, 'mismatches' => 0), r.inspect
      expect(r['nativeAtomics']).to be >= 1, r.inspect
      # …and each of those still lays out an atomic it CAN walk.
      expect_native_atomic(%(<div style="overflow:hidden;width:400px"><div style="float:left;width:200px">f <span style="display:inline-block">ok</span> g</div></div>))
      expect_native_atomic(%(<div style="width:400px;position:relative"><div style="position:absolute;left:0;right:100px">a <span style="display:inline-block">in</span> b</div><p>x</p></div>))
      # …while a text block native only LAYS OUT keeps the pushed box: the decline cascades up to the outermost
      # atomic, whose own text block is not measured, and THAT atomic is pushed whole.
      r = run_shadow(%(<div style="width:400px">a <span style="display:inline-block">a <span style="#{ib}">in</span> b</span> c</div>))
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
      expect_native_atomic('<div style="width:400px">a <span style="display:inline-block"><div style="position:relative">t <span style="display:inline-block">ok</span></div></span> c</div>', 2)
    end
    it 'answers the same refusal for an inline image' do
      # `nlAtomicNative` tests the WIDTH keyword before the `inline` branch, because a replaced element's width
      # comes from its own intrinsic size and the walk refuses that record on the same ground — so a cell
      # holding one pushes its contribution instead of taking the table down, exactly as for an inline-block.
      img = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
      [%(<img style="width:fit-content;height:10px" src="#{img}">), %(<img style="width:max-content;height:10px" src="#{img}">)].each do |tag|
        r = run_shadow(%(<table style="border-spacing:0"><tr><td style="padding:0">a #{tag}</td></tr></table>))
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{tag}: #{r.inspect}"
      end
      # …while an image it does lay out stays native, in a cell and on an ordinary line
      expect_native_atomic(%(<table style="border-spacing:0"><tr><td style="padding:0">a <img style="width:20px;height:10px" src="#{img}"></td></tr></table>))
      expect_native_atomic(%(<div style="width:400px">a <img style="width:20px;height:10px" src="#{img}"> b</div>))
    end
    it 'rolls a declined subtree back off the record stream and pushes its box' do
      [
        # (a POSITIONED float, which the walk still defers. This fixture used to hold a static one, which native
        # has since taken over as a marker on the line.)
        '<div style="width:400px">text <span style="display:inline-block"><div style="float:left;position:relative;width:10px;height:10px"></div>beside</span> after</div>',
        # (a SOFT hyphen: the flow draws a hyphen that is not in the text where it breaks, which native models
        # neither in the line's width nor in the painter's runs. This fixture used to read `日本語` — served
        # with no charset, whose mojibake happens to contain an em dash, so what it actually exercised was the
        # hyphen refusal that native has since taken over.)
        "<div style=\"width:400px\">text <span style=\"display:inline-block\">a\u00ADb</span> after</div>",
        # (a preserved FORM FEED, which native's pen-walk does not measure. This fixture used to hold a TAB,
        # which native has since taken over — tab stops are its own now, so a tabbed subtree stays native.)
        "<div style=\"width:400px\">text <span style=\"display:inline-block;white-space:pre\">a\fb</span> after</div>"
      ].each do |body|
        r = run_shadow(body)
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), "#{body}: #{r.inspect}"
      end
      expect_native_atomic('<div style="width:400px"><span style="display:inline-block">ok</span> and <span style="display:inline-block"><div style="float:left;position:relative;width:10px;height:10px"></div>beside</span> after</div>', 1)
      # …and the tabbed one the other way round: its subtree is native, so nothing is rolled back
      expect_native_atomic("<div style=\"width:400px\">text <span style=\"display:inline-block;white-space:pre\">a\tb</span> after</div>", 1)
    end
    # An atomic aligned against its PARENT's font box hangs from where that alignment puts its margin box, which
    # is only known once native has laid it out — so the run carries the alignment and the one figure of the
    # parent's font it reads, and native applies the rule itself. Each alignment beside a TALL baseline box, so
    # a wrong ascent moves the line; under a parent in another font size and a raised one, so the figure is the
    # parent's and not the block's; and inside an inline-block, which then measures it.
    it 'lays out an atomic aligned against its parent font box itself' do
      %w[middle text-top text-bottom -webkit-baseline-middle].each do |va|
        box = %(<span style="display:inline-block;width:10px;height:37px;margin:3px 0 5px;vertical-align:#{va}"></span>)
        expect_native_atomic(%(<div style="width:400px">text #{MARKER}#{box} x</div>), 2)
        # …a box with a baseline of its own, which the alignment ignores
        expect_native_atomic(%(<div style="width:400px">text #{MARKER}<span style="display:inline-block;font-size:24px;vertical-align:#{va}">ab<br>cd</span> x</div>), 2)
        expect_native_atomic(%(<div style="width:400px">t #{MARKER}<span style="font-size:30px">big #{box}</span></div>), 2)
        expect_native_atomic(%(<div style="width:400px">t #{MARKER}<span style="vertical-align:6px">up #{box}</span></div>), 2)
        expect_native_atomic(%(<div style="width:400px">a <span style="display:inline-block">t <img style="width:9px;height:20px;vertical-align:#{va}"> x</span></div>), 2)
      end
      # …while `top` / `bottom` hang from the LINE rather than from the parent's font box, so they take none of
      # the rule above: the box goes over with the line mode instead of an alignment code, and `growAtomic`
      # never reaches `alignedAscent` for one. A baseline SHIFT on such a box is IGNORED by both engines —
      # that is what the `super` case here pins, and it is the one place the two families meet.
      %w[top bottom].each do |va|
        expect_native_atomic(%(<div style="width:400px">text #{VA_MARKS}<span style="display:inline-block;vertical-align:#{va};width:10px;height:30px"></span> x</div>), 3)
        expect_native_atomic(%(<div style="width:400px">text #{VA_MARKS}<span style="vertical-align:super">up <span style="display:inline-block;vertical-align:#{va};width:10px;height:30px"></span></span> x</div>), 3)
      end
    end

    # An intrinsic-size KEYWORD width on an atomic takes the figure it names — `fit-content` clamped to the line's
    # shrink-to-fit width, as the oracle's `usedSize` clamps its `autoW` — where it used to be pushed: an atomic's
    # width was always the shrink-to-fit one. Each keyword where the three figures differ (a wrapping run in a
    # narrow line), with edges, and inside the routes that then MEASURE it.
    it 'lays out an atomic with an intrinsic-size keyword width itself' do
      %w[min-content max-content fit-content].each do |kw|
        box = %(<span style="display:inline-block;width:#{kw};padding:0 3px;border:1px solid">aa bbb cccc dd eeeeeee</span>)
        expect_native_atomic(%(<div style="width:70px">text #{box} after</div>))
        expect_native_atomic(%(<div style="width:400px">text <span style="display:inline-flex;width:#{kw};padding:0 5%"><span>f one</span><span>two</span></span></div>))
        expect_native_atomic(%(<div style="display:flex;width:300px"><div>x #{box}</div><div style="flex:1">y</div></div>))
        expect_native_atomic(%(<div style="width:400px">q <span style="display:inline-block">#{box}</span> r</div>), 2)
      end
      # …`fit-content` where min-content exceeds max-content (a negative margin takes the line's max under its
      # widest piece): min-content wins, in a block and on a line alike
      crossed = '<span style="display:inline-block;width:50px;height:5px"></span><span style="display:inline-block;margin-left:-100px"></span>'
      expect_native_atomic(%(<div style="width:400px">a <span style="display:inline-block;width:fit-content">#{crossed}</span></div>), 3)
      expect_native_atomic(%(<div style="width:400px"><div style="width:fit-content">#{crossed}</div></div>), 2)
      # …and a WRAPPING inline-flex, which the oracle grows only from an auto width
      item = '<div style="width:80px;height:10px;flex-shrink:0"></div><div style="width:30px;height:10px"></div>'
      expect_native_atomic(%(<div style="width:400px">t <span style="display:inline-flex;flex-wrap:wrap;width:max-content">#{item}</span> u</div>))
      expect_native_atomic(%(<div style="width:400px">t <span style="display:inline-flex;flex-wrap:wrap;width:fit-content;max-width:60px">#{item}</span> u</div>))
      # …but not on a REPLACED atomic, whose width is its intrinsic size: the walk refuses that one
      r = run_shadow('<div style="width:400px">a <img style="width:max-content;height:10px"> b</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), r.inspect
    end

    # An INLINE-TABLE is native's own too. Its width is the table algorithm's shrink-to-fit (§17.5.2 —
    # `measure_table`'s `self_sizes`, not the line's) and its baseline the one `measure_table` now stamps on
    # the table's box, which is THREE figures because three callers ask different questions: a flex line and a
    # baseline cell read the first row's FIRST cell's first line; a `last baseline` flex line the last row's
    # LAST cell's last line; and an ATOMIC the last row's last cell answered UNDER THE ATOMIC RULES (a scroll
    # container inside it gives its bottom margin edge, a table inside it gives nothing) — which is what the
    # oracle reaches by carrying its `inlineBlock` flag down the whole recursion. Three wrong rules got here
    # first, each caught only by the sweep below: `row_baseline` (the figure the baseline GROUP aligns on,
    # empty for a table whose cells are not baseline-aligned — every default `<td>`, which computes
    # `vertical-align: inherit`) 4px out, no baseline at all 4px out, and the cell's FIRST line for the last
    # figure, which is 18px out on a two-line cell. A fourth read the cell's own answer where the CELL itself
    # scrolls, which is a different question again (`atomic_baseline_of`).
    #
    # EVERY SHAPE HERE PUTS A MARKER BOX ON THE LINE, and that is the point: a text run is not a compared box,
    # so a line whose ascent is wrong moves nothing the harness looks at. Measured on the rule this replaced
    # (it read the cell's FIRST line): the `inlinetable` sweep reported 240 mismatches with the markers in and
    # 0 with every one of them stripped. It is 0 either way now, which is what the markers are there to keep
    # meaningful — strip them and the next wrong rule is silent again.
    it 'lays out an inline-table on a line, from the figure an atomic asks for' do
      marker = '<span style="display:inline-block;width:4px;height:4px"></span>'
      ['<table style="display:inline-table"><tr><td>cell</td></tr></table>',
       '<span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">cell</span></span></span>',
       '<span style="display:inline-table"><span style="display:table-cell">bb</span></span>',
       '<table style="display:inline-table;padding:0 10%"><tr><td>hello</td></tr></table>',
       # …cells whose baselines DIFFER, which is the only way first-vs-last cell shows at all
       '<table style="display:inline-table"><tr><td style="font-size:40px">A</td><td>b</td></tr></table>',
       '<table style="display:inline-table"><tr><td>a</td><td style="font-size:40px">B</td></tr></table>',
       '<div style="display:inline-table"><div style="display:table-row"><div style="display:table-cell;vertical-align:middle;height:40px">t</div><div style="display:table-cell">c</div></div></div>',
       '<table style="display:inline-table"><tr><td>a</td></tr><tr><td style="font-size:30px">B</td></tr></table>',
       # …a MULTI-LINE last cell, which is the only way first-vs-last LINE inside that cell shows
       '<div style="display:inline-table"><div style="display:table-row"><div style="display:table-cell">a</div><div style="display:table-cell">x<br>y</div></div></div>',
       '<div style="display:inline-table"><div style="display:table-row"><div style="display:table-cell"><div>p</div><div>q</div></div></div></div>',
       # …a SCROLLER in the last cell, which the atomic figure answers differently from the flex one
       '<div style="display:inline-table"><div style="display:table-row"><div style="display:table-cell">c</div><div style="display:table-cell"><div style="overflow:hidden;height:12px">s</div></div></div></div>',
       # …and a nested table in a cell, which gives the atomic no baseline at all (both engines)
       '<div style="display:inline-table"><div style="display:table-row"><div style="display:table-cell"><div style="display:table"><div style="display:table-row"><div style="display:table-cell">n</div></div></div></div></div></div>'].each do |table|
        # 2, not 1: the MARKER is an atomic too, so a count of 1 is satisfied by the marker alone and the
        # example passes with the table still pushed — which is what it did until this comment was written.
        expect_native_atomic(%(<div style="width:400px">x #{table}#{marker} y</div>), 2)
      end
      # …and a table generates no LINE BOX (CSS 2.1 §10.8.1), so an atomic holding one hangs from its bottom
      # margin edge — the table's own baseline is for a flex line and a table cell to read.
      expect_native_atomic(%(<div style="width:400px">x <span style="display:inline-flex"><table style="display:inline-table"><tr><td>c</td></tr></table></span>#{marker} y</div>), 2)
    end
    # …and it is PUSHED where the two engines would not be walking the same rows: a `<tfoot>` renders after the
    # body whatever its position in the markup (§17.2.1), which `tableGrid` and the walk follow, while the
    # oracle's `baselineCandidates` yields DOM order — so its "last" row is the last DOM child (marker y 28
    # against 10). A CAPTION is in that list too and native's rows are not, so one written AFTER the rows is
    # the oracle's first candidate in a `last = true` walk and answers before any row (js 23, native 47,
    # Chrome 51 — neither is right). And the oracle's scroll arm adds a table-internal box's own bottom
    # MARGIN, where the table algorithm and Chrome give it none (js 32, native 22, Chrome 18).
    #
    # All three want the ORACLE changed, and none of them is the first-vs-last-row rule: going to the FIRST
    # row does not make the walk order stop mattering, because the oracle's list is DOM order at both ends —
    # the ungated cell path proves it (nat 10, js 41, and 41 IS the first-baseline figure).
    it 'pushes an inline-table whose baseline the two engines would not walk alike' do
      marker = '<span style="display:inline-block;width:4px;height:4px"></span>'
      # (1, not 2: the marker is native's, the table is pushed)
      ['<table style="display:inline-table"><tfoot><tr><td>f</td></tr></tfoot><tbody><tr><td>b</td></tr></tbody></table>',
       '<table style="display:inline-table"><tr><td>a</td></tr><caption style="font-size:30px">C</caption></table>',
       '<div style="display:inline-table"><div style="display:table-row;overflow:hidden;height:12px;margin-bottom:10px"><div style="display:table-cell">s</div></div></div>'].each do |table|
        r = run_shadow(%(<div style="width:400px">x #{table}#{marker} y</div>))
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 1), table
      end
      # …and the shapes each one is the edge of still lay out: groups in document order, a caption in its
      # normal position BEFORE the rows (the oracle reaches the rows first there), and a percentage margin,
      # which resolves against nothing in either engine.
      ['<table style="display:inline-table"><thead><tr><td>h</td></tr></thead><tbody><tr><td>b</td></tr></tbody></table>',
       '<table style="display:inline-table"><caption style="font-size:30px">C</caption><tr><td>a</td></tr></table>',
       '<div style="display:inline-table"><div style="display:table-row;overflow:hidden;height:12px;margin-bottom:10%"><div style="display:table-cell">s</div></div></div>'].each do |table|
        r = run_shadow(%(<div style="width:400px">x #{table}#{marker} y</div>))
        expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 2), table
      end
    end
    it 'keeps the pushed box for an atomic whose own subtree declines' do
      # …an atomic the walk refuses INSIDE (a bare table-cell in an inline-block) rolls back to the pushed box
      # rather than declining the pass. An inline-FLEX, an inline-GRID and an inline-TABLE are native's own.
      r = run_shadow('<div style="width:400px">text <span style="display:inline-block"><div style="display:table-cell">c</div></span> x</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0)
      r = run_shadow('<div style="width:400px">text <span style="display:inline-flex"><div>f</div></span> x</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 1)
    end

    # A CONTROL is an atomic native lays out itself now. Its box is the replaced one and its baseline the
    # chrome's — which is where the oracle keeps TWO answers that do not agree, and native keeps both:
    # `boxBaselineOffset` (what a container's scan takes from the box) gives nothing for a control that draws
    # no text, while `atomicBaselineOffset` (what it hands the line) gives its border-box bottom. Reading the
    # first where the second was wanted hung a checkbox from its MARGIN box, 3px of UA sheet lower.
    #
    # EVERY example here puts a TALL baseline-aligned box on the line beside the control. Without one the
    # line's ascent is just the control's own, so a wrong ascent moves nothing and the example passes — which
    # is how a percentage-padding bug survived a 1000-case sweep and shipped (see the `%` example below).
    MARKER = '<span style="display:inline-block;width:5px;height:60px"></span>'
    CONTROLS = [
      '<input>',
      '<input type="checkbox">',
      '<input type="radio">',
      '<input type="range">',
      '<input type="file">',
      '<input type="submit" value="Go">',
      '<select><option>a</option></select>',
      '<textarea></textarea>',
      '<canvas width="20" height="20"></canvas>',
      '<img style="width:20px;height:20px">'
    ].freeze

    it 'lays out a control atomic itself, from its own chrome baseline' do
      CONTROLS.each do |control|
        expect_native_atomic(%(<div style="width:400px">text #{MARKER}#{control} after</div>))
        expect_native_atomic(%(<div style="width:400px;font-size:32px">BIG #{MARKER}#{control} after</div>))
        expect_native_atomic(%(<div style="width:400px">t #{MARKER}#{control.sub('>', ' style="margin-bottom:6px">')} u</div>))
      end
    end

    # A PERCENTAGE vertical padding resolves against the containing block, and `controlBaseline` was reading
    # the box's edges with no basis at all — so half of it went missing from the ascent. A symmetric padding
    # cancelled, which is why only the one-sided spellings show it (Chrome and native agree; the oracle did
    # not, and this is the oracle's own fix).
    it 'resolves a percentage padding before taking a control\'s baseline' do
      ['padding-top:10%', 'padding-bottom:10%', 'padding:10%', 'padding:10% 0 4px',
       'padding-top:calc(10% + 2px)'].each do |pad|
        expect_parity(%(<div style="width:400px">t #{MARKER}<input style="#{pad}"> u</div>))
        expect_parity(%(<div style="width:200px">t #{MARKER}<input style="#{pad}"> u</div>))
      end
    end

    # …and the THIRD bug the same increment fixed: the two baseline answers are kept apart. A block-level
    # checkbox inside an inline-block is read by the container's SCAN, which gets nothing from it — reuniting
    # the fields would give it the atomic answer and move the box by its bottom margin.
    it 'gives a container\'s baseline scan nothing from a control that draws no text' do
      ['margin-bottom:6px', 'margin-bottom:0', 'margin:4px 0'].each do |m|
        expect_parity(%(<div style="width:400px">t <span style="display:inline-block"><input type="checkbox" style="display:block;#{m}"></span> #{MARKER} u</div>))
      end
    end
  end
  # An `inline-flex` / `inline-grid` is an atomic whose OWN container native lays out. Both were pushed — the
  # oracle's box marshalled onto the record — because an atomic's width is its line's SHRINK-TO-FIT and the
  # walk had no intrinsic measure to offer for one. It has both now, so the display alone decides nothing:
  # three gates that read it (`nlAtomicNative`, `nlFlexSupported`, `nlGridSupported`) admit an atomic one.
  describe 'an inline-flex / inline-grid is an atomic native lays out' do
    # `nativeAtomics` is the whole point — parity alone cannot fail here, because the PUSHED path was already
    # parity-clean. What changed is which engine produced the box.
    it 'lays out an atomic flex or grid container itself' do
      [
        '<span style="display:inline-flex"><div style="width:50px;height:30px"></div><div style="width:80px;height:40px"></div></span>',
        '<span style="display:inline-flex;flex-direction:column"><div style="width:50px;height:30px"></div><div style="width:80px;height:40px"></div></span>',
        '<span style="display:inline-flex;justify-content:space-between;align-items:baseline"><div style="font-size:24px">a</div><div>b</div></span>',
        '<span style="display:inline-grid;grid-template-columns:30px 20px"><div style="height:10px"></div><div style="height:10px"></div></span>',
        '<span style="display:inline-grid;grid-template-columns:min-content auto"><div>aa bb</div><div>x</div></span>'
      ].each do |atom|
        expect_native_atomic(%(<div style="width:400px">text #{atom} after</div>))
        expect_native_atomic(%(<div style="width:400px;text-align:right">text #{atom} after</div>))
        expect_native_atomic(%(<div style="width:90px">text #{atom} after</div>))
      end
    end
    # …and what the atomic itself declares still sizes it: a width PINS the shrink-to-fit, the clamps bind it,
    # the edges are inside it, and a `vertical-align` moves it on the line rather than off the native path.
    it 'respects the atomic own declarations' do
      atom = '<span style="display:inline-flex;%s"><div style="width:50px;height:30px"></div><div style="width:80px;height:40px"></div></span>'
      ['width:120px', 'min-width:150px', 'max-width:40px', 'padding:4px', 'border:2px solid',
       'margin:0 6px', 'box-sizing:border-box;width:120px;padding:4px', 'vertical-align:super',
       'vertical-align:-4px', 'font-size:24px'].each do |decl|
        expect_native_atomic(%(<div style="width:400px">text #{format(atom, decl)} after</div>))
      end
    end
    # …while an atomic whose own subtree the walk refuses keeps the PUSHED box — the route rolls back rather
    # than taking the pass down with it.
    it 'keeps pushing an atomic it cannot walk' do
      r = run_shadow('<div style="width:400px">text <span style="display:inline-block"><div style="display:table-cell">c</div></span> after</div>')
      expect(r).to include('ok' => true, 'mismatches' => 0, 'nativeAtomics' => 0), r.inspect
    end
    # An auto-width WRAPPING flex container is GROWN past its intrinsic figure once laid out — to what its own
    # layout reached (`growAtomic`'s caller, `_lbFlowRight`; native's `flow_right`) — which takes an item that
    # cannot SHRINK to see, and is a question of neither axis nor line count: a column's lines add up, and a
    # row's unshrinkable item overflows the line just the same. The growth moves the pen but not the break: the
    # line decided where it breaks on the width it reserved. Each wrap mode against a text run that follows it
    # on a line narrow enough to care, so both halves show; and a DECLARED width, which is never grown.
    it 'grows an auto-width wrapping flex container to what its layout reached' do
      item = '<div style="width:80px;height:10px;flex-shrink:0"></div>'
      ['flex-wrap:wrap', 'flex-wrap:wrap;flex-direction:row-reverse',
       'flex-wrap:wrap;flex-direction:column;height:60px', 'flex-wrap:wrap;flex-direction:column-reverse;height:60px',
       'flex-wrap:wrap;writing-mode:vertical-rl;flex-direction:column'].each do |wrap|
        expect_native_atomic(%(<div style="width:400px">text <span style="display:inline-flex;#{wrap};max-width:40px">#{item}</span> after</div>))
        expect_native_atomic(%(<div style="width:130px">text <span style="display:inline-flex;#{wrap};max-width:40px">#{item}</span> after words</div>))
        expect_native_atomic(%(<div style="width:400px;text-align:center">t <span style="display:inline-flex;#{wrap};max-width:40px">#{item}</span></div>))
        expect_native_atomic(%(<div style="width:400px">text <span style="display:inline-flex;#{wrap};width:60px">#{item}</span> after</div>))
      end
      # …columns that add up, and a grandchild wider than its item
      expect_native_atomic('<div style="width:400px">a <span style="display:inline-flex;flex-flow:column wrap;height:40px"><div style="width:50px;height:30px"></div><div style="width:80px;height:30px"></div></span> b</div>')
      expect_native_atomic('<div style="width:400px">a <span style="display:inline-flex;flex-wrap:wrap"><div style="width:50px;height:30px"><div style="width:120px;height:6px"></div></div></span> b</div>')
      # …and only BOXES reach: an overflowing word, a `<br>` after one or a relatively shifted inline is a piece
      # of its item's lines, which grows nothing (Chrome: 30, 30, 50 — the oracle used to union those fragments
      # and made 85 / 85 / 108, where native has no box for any of them). An atomic inside such an inline is a box.
      ['<div style="width:30px"><span>aaaaaaaaaaaa</span></div>', '<div style="width:30px">aaaaaaaaaaaa<br>b</div>',
       '<div style="width:50px"><span style="position:relative;left:100px">x</span></div>',
       '<div style="width:30px">x <span style="position:relative;left:40px"><img style="width:20px;height:5px"></span></div>'].each do |content|
        expect_native_atomic(%(<div style="width:400px">a <span style="display:inline-flex;flex-wrap:wrap">#{content}</span> b</div>))
      end
      # …and nothing out of flow reaches into the growth
      expect_native_atomic('<div style="width:400px">a <span style="display:inline-flex;flex-wrap:wrap;position:relative"><div style="width:20px;height:5px"></div><div style="position:absolute;left:0;width:300px;height:5px"></div></span> b</div>')
    end
  end
end
