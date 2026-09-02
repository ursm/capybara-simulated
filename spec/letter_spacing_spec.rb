# frozen_string_literal: true

require 'capybara/simulated'
require 'vips'
require_relative 'support/session_teardown'

# `letter-spacing` and `word-spacing` are part of an advance. The flow measured a run from the
# face's own `hmtx` advances and read neither property, so a spaced heading measured at its unspaced
# width and wrapped two lines where Chrome wraps three — while `getComputedStyle` reported the
# spacing correctly the whole time.
#
# The rule, Chrome-measured at 16px monospace: letter-spacing is added after EVERY character, the
# last one included, and word-spacing after each word separator on top of it.
#
# Every width here is asserted as the DIFFERENCE from the same run unspaced — the spacing times the
# characters it applies to — and never as an absolute number. The face's advance is the machine's:
# 9.6px per glyph here, 9.6328 on CI, and an absolute assertion turned every CI job red on the first
# push. The spacing is what the assertion is about, and it is exact whatever the face.
RSpec.describe 'letter-spacing and word-spacing reach the flow' do
  def page(body, css = '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { margin: 0; font: 16px monospace }
          span { white-space: pre }
          #{css}
        </style></head><body>#{body}</body></html>
      HTML
    })
    session.visit '/'
    session
  end

  def size(session, id = 't')
    session.evaluate_script(<<~JS)
      (function () {
        var r = document.getElementById(#{id.to_json}).getBoundingClientRect();
        return [r.width, r.height];
      })()
    JS
  end

  def width(session, id = 't') = size(session, id)[0]

  # The width a run GAINS from its spacing: the same markup with and without the style.
  def gain(body_with_style, body_plain, css = '')
    width(page(body_with_style, css)) - width(page(body_plain, css))
  end

  it 'adds letter-spacing after every character, the last one included' do
    expect(gain('<div><span id=t style="letter-spacing:10px">abcd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(40)                      # 4 characters x 10px
  end

  it 'takes a negative letter-spacing' do
    expect(gain('<div><span id=t style="letter-spacing:-3px">abcd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(-12)
  end

  it 'spaces a single character too' do
    expect(gain('<div><span id=t style="letter-spacing:10px">a</span></div>', '<div><span id=t>a</span></div>'))
      .to be_within(0.01).of(10)
  end

  it 'resolves a font-relative letter-spacing' do
    expect(gain('<div><span id=t style="letter-spacing:1em">abcd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(64)                      # 4 x 16px
  end

  it 'adds word-spacing after each word separator' do
    expect(gain('<div><span id=t style="word-spacing:20px">ab cd ef</span></div>', '<div><span id=t>ab cd ef</span></div>'))
      .to be_within(0.01).of(40)                      # 2 separators
  end

  it 'counts a preserved trailing space as a separator' do
    expect(gain('<div><span id=t style="word-spacing:20px">ab cd ef </span></div>', '<div><span id=t>ab cd ef </span></div>'))
      .to be_within(0.01).of(60)                      # 3, the trailing one included
  end

  it 'letter-spaces the space itself' do
    expect(gain('<div><span id=t style="letter-spacing:10px">ab cd</span></div>', '<div><span id=t>ab cd</span></div>'))
      .to be_within(0.01).of(50)                      # 5 characters, the space among them
  end

  it 'adds both spacings together' do
    expect(gain('<div><span id=t style="letter-spacing:10px;word-spacing:20px">ab cd</span></div>', '<div><span id=t>ab cd</span></div>'))
      .to be_within(0.01).of(70)                      # 5 x 10 + 1 x 20
  end

  it 'counts a CJK character once' do
    expect(gain('<div><span id=t style="letter-spacing:10px">日本語</span></div>', '<div><span id=t>日本語</span></div>'))
      .to be_within(0.01).of(30)
  end

  it 'leaves an empty run empty' do
    expect(width(page('<div><span id=t style="letter-spacing:10px"></span></div>'))).to eq(0)
  end

  # …and the line breaks where the SPACED words run out of room: "abcd efgh ijkl" in 120px is two
  # lines unspaced and three under `letter-spacing: 10px` (Chrome). Line COUNTS, against the height
  # of one line of the same font — the line box's height is the face's.
  it 'breaks lines on the spaced width' do
    # A container just wide enough for "abcd efgh" UNSPACED, whatever the face: the unspaced run
    # then wraps once (before "ijkl") and the spaced one — 90px longer — twice.
    fits = (width(page('<div><span id=t>abcd efgh</span></div>')) + 1).ceil
    box  = ->(style) { "<div style=\"width:#{fits}px\"><span id=t style=\"white-space:normal;#{style}\">abcd efgh ijkl</span></div>" }
    # Line COUNTS, as a rounded ratio: a face with a fractional line box (17.5px) snaps three lines
    # to 53 rather than 52.5, and the count is what the example is about.
    one_line = size(page(box.call('')))[1] / 2.0
    expect((size(page(box.call('letter-spacing:10px')))[1] / one_line).round).to eq(3)
  end

  it 'inherits the spacing into a child that declares none' do
    expect(gain('<div style="letter-spacing:10px"><span id=t>abcd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(40)
  end

  it 'lets a child override the spacing it inherits' do
    expect(gain('<div style="letter-spacing:10px"><span id=t style="letter-spacing:0">abcd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(0)
  end

  # ── inheritance crosses a font boundary ──
  # The O(1) gate sees an element's OWN inline map, and an ancestor's inline declaration is in the
  # ancestor's. A child with a font of its own — a `<b>`, a `<code>`, a `font-size` — builds its own
  # record, and reading the computed spacing there lost the inherited value on any page where no
  # RULE declared the property (measured: 38.4 where Chrome has 78.41). The record takes the
  # parent's figure instead.
  it 'inherits an inline ancestor spacing through a bold child' do
    expect(gain('<div style="letter-spacing:10px"><b id=t>abcd</b></div>', '<div><b id=t>abcd</b></div>', 'b{white-space:pre}'))
      .to be_within(0.01).of(40)
  end

  it 'inherits an inline ancestor spacing through a child with its own font-size' do
    expect(gain('<div style="letter-spacing:10px"><span id=t style="font-size:32px">abcd</span></div>',
                '<div><span id=t style="font-size:32px">abcd</span></div>')).to be_within(0.01).of(40)
  end

  it 'inherits an inline ancestor word-spacing through a bold child' do
    expect(gain('<div style="word-spacing:20px"><b id=t>ab cd</b></div>', '<div><b id=t>ab cd</b></div>', 'b{white-space:pre}'))
      .to be_within(0.01).of(20)
  end

  # ── percentages and calc() ──
  # A percentage is of the FONT SIZE — 50% at 16px is 8px — and Chrome takes one for
  # `letter-spacing` as well. `parseFloat` read `50%` as 50 pixels.
  it 'resolves a word-spacing percentage against the font size' do
    expect(gain('<div><span id=t style="word-spacing:50%">ab cd</span></div>', '<div><span id=t>ab cd</span></div>'))
      .to be_within(0.01).of(8)                       # 50% of 16px, once
  end

  it 'resolves a letter-spacing percentage against the font size' do
    expect(gain('<div><span id=t style="letter-spacing:50%">ab cd</span></div>', '<div><span id=t>ab cd</span></div>'))
      .to be_within(0.01).of(40)                      # 5 x 8px
  end

  it 'resolves a calc() with a percentage in it' do
    expect(gain('<div><span id=t style="word-spacing:calc(50% + 2px)">ab cd</span></div>', '<div><span id=t>ab cd</span></div>'))
      .to be_within(0.01).of(10)
  end

  # ── what takes no spacing ──
  # Blink adds letter-spacing once per grapheme cluster and never after a character with no width
  # of its own: a soft hyphen, a zero-width space, a combining mark, and whatever follows a zero
  # width joiner. Those have no ADVANCE either — charging them the Latin mean made `ab&shy;cd`
  # 9.6px wider than `abcd` before any spacing was involved.
  it 'gives a soft hyphen neither an advance nor a spacing' do
    expect(gain('<div><span id=t>ab&shy;cd</span></div>', '<div><span id=t>abcd</span></div>')).to be_within(0.01).of(0)
    expect(gain('<div><span id=t style="letter-spacing:10px">ab&shy;cd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(40)
  end

  it 'gives a zero-width space no spacing' do
    expect(gain('<div><span id=t style="letter-spacing:10px">ab&#x200B;cd</span></div>', '<div><span id=t>abcd</span></div>'))
      .to be_within(0.01).of(40)
  end

  it 'spaces a combining sequence once' do
    expect(gain('<div><span id=t style="letter-spacing:10px">e&#x301;</span></div>', '<div><span id=t>e&#x301;</span></div>'))
      .to be_within(0.01).of(10)
  end

  it 'spaces a ZWJ emoji sequence once' do
    # Against the unspaced sequence: the base advance of an astral cluster is an estimate here
    # (16 where Chrome has 19.92, a separate gap), and what this pins is that the SPACING is added
    # once for the whole family rather than once per code point (Chrome: +10, not +70).
    plain  = width(page('<div><span id=t>👨&#x200D;👩&#x200D;👧&#x200D;👦</span></div>'))
    spaced = width(page('<div><span id=t style="letter-spacing:10px">👨&#x200D;👩&#x200D;👧&#x200D;👦</span></div>'))
    expect(spaced - plain).to be_within(0.05).of(10)
  end

  # ── a control character in a button label ──
  # A newline in an `<input type=button>` value is a LINE BREAK (Chromium 922011): the button is as
  # wide as its widest line and as tall as all of them. Charging the newline nothing as a
  # zero-width character — right for flow text, where a collapsed newline became a space long
  # before it was measured — made `"1\n2"` the same box as `"12"`, and WPT's mismatch test noticed.
  # Against controls, since the digits' advance and the control's chrome are the face's and the
  # machine's; Chrome measures 23.42x36 against 30.83x21 for `"12"`.
  it 'breaks a button label at a newline' do
    s = page('<input type=button value="1&#10;2" id=t><input type=button value="12" id=u><input type=button value="1" id=v>')
    expect(size(s, 't')[0]).to be_within(0.05).of(size(s, 'v')[0])   # one digit wide
    expect(size(s, 't')[0]).to be < size(s, 'u')[0]
    expect(size(s, 't')[1]).to be > size(s, 'u')[1]                  # and taller
  end

  # ── the page-facing canvas API ──
  # `CanvasRenderingContext2D.letterSpacing` / `wordSpacing` were parsed and MEASURED but never
  # drawn. A spaced run is drawn one character at a time now, each character's advance taken as
  # the difference between two host measures with a sentinel glyph appended — the host reports INK
  # widths, so a lone `a` is 8 where the face advances 10, and a trailing space measures nothing
  # at all. Against the unspaced run's own glyph columns, since the host's measures are integers
  # and the face is the machine's: a word-spacing must not move the letters INSIDE a word.
  it 'draws a word-spaced canvas run with its letters where they were' do
    s = page('<canvas id=c width=300 height=60></canvas>')
    starts = s.evaluate_script(<<~JS)
      (function () {
        var g = document.getElementById('c').getContext('2d');
        g.font = '16px monospace';
        function cols() {
          var d = g.getImageData(0, 0, 300, 30).data, inked = [];
          for (var x = 0; x < 300; x++) { for (var y = 0; y < 30; y++) if (d[(y * 300 + x) * 4 + 3] > 128) { inked.push(x); break; } }
          var starts = [];
          for (var i = 0; i < inked.length; i++) if (i === 0 || inked[i] !== inked[i - 1] + 1) starts.push(inked[i]);
          return starts;
        }
        g.fillText('ab cd', 10, 20);
        var plain = cols();
        g.clearRect(0, 0, 300, 60); g.wordSpacing = '20px'; g.fillText('ab cd', 10, 20);
        var spaced = cols();
        g.clearRect(0, 0, 300, 60); g.wordSpacing = '0px'; g.letterSpacing = '10px'; g.fillText('abcd', 10, 20);
        var lettered = cols();
        return { plain: plain, spaced: spaced, lettered: lettered };
      })()
    JS
    plain, spaced, lettered = starts.values_at('plain', 'spaced', 'lettered')
    expect(plain.size).to eq(4)
    expect((spaced[1] - plain[1]).abs).to be <= 1                 # `b` stays put
    expect(spaced[2] - plain[2]).to be_between(19, 21)            # `c` moves by the word-spacing
    expect(lettered[1] - plain[1]).to be_between(9, 11)           # `b` moves by one letter-spacing
  end

  # ── the painter ──
  # The glyphs land where the box says they do: a spaced run's INK extends past the unspaced run's
  # by the spacing between its characters. Against a control rather than a number, since the ink
  # width of a glyph is the face's and the face is the machine's; the gap between the two is the
  # spacing alone, and that is font-independent.
  it 'paints the glyphs at the spaced positions' do
    s = page('<div><span id=u>abcd</span></div><div><span id=t style="letter-spacing:10px">abcd</span></div>')
    # Each run's own line, from its rect — the line box's height is the face's.
    band = ->(id) { s.evaluate_script("(function () { var r = document.getElementById(#{id.to_json}).getBoundingClientRect(); return [Math.floor(r.top), Math.ceil(r.bottom)]; })()") }
    path = File.join(Dir.tmpdir, "csim-ls-#{Process.pid}.png")
    begin
      s.driver.save_screenshot(path)
      img = Vips::Image.new_from_file(path)
      raw = img.write_to_memory
      bands = img.bands
      ink_right = lambda do |(y0, y1)|
        (0...img.width).select {|x| (y0...y1).any? {|y| raw.byteslice(((y * img.width) + x) * bands, 3).bytes[0] < 128 } }.max
      end
      unspaced = ink_right.call(band.call('u'))
      spaced   = ink_right.call(band.call('t'))
      expect(spaced - unspaced).to be_between(28, 32)      # 3 gaps of 10px, ± antialiasing
    ensure
      File.delete(path) if File.exist?(path)
    end
  end
end
