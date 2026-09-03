# frozen_string_literal: true

require 'capybara/simulated'
require 'vips'
require_relative 'support/session_teardown'

# A preserved tab advances to the next TAB STOP: stops every `tab-size` from the block's content
# edge (CSS Text 3 §3.1). The flow gave a tab no width at all, so a `<pre>` code block's columns
# collapsed onto its text.
#
# The rules, Chrome-measured on 300px `<pre>` blocks at 16px monospace (27 cases, all matched):
#   - the stop is the tab's OWN element's `tab-size` (`code { tab-size: 4 }` inside a `pre` stops
#     every 4) x the BLOCK's space advance, letter- and word-spacing included (8 x (9.6 + 2)
#     under `letter-spacing: 2px`), or the length as given; a percentage is not a `tab-size`
#   - stops are counted from the content edge: padding moves them, `text-indent` does not, a
#     pre span in the middle of a line uses the block's edge, a tab inside a bigger inline uses
#     the block's font
#   - a tab sitting exactly on a stop takes the whole next one, and one whose stop is less than
#     HALF A SPACE away takes the one after (Blink's `Font::TabWidth`)
#   - `tab-size: 0` leaves a tab the width of the letter-spacing alone
#
# Every x is a formula over the space advance measured on the same page — the face is the
# machine's, the arithmetic is not.
RSpec.describe 'tab stops' do
  def page(body, css = '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { margin: 0; font: 16px monospace }
          pre { margin: 0; font: 16px monospace; width: 300px }
          #{css}
        </style></head><body>#{body}<span id="__w" style="white-space:pre"> </span></body></html>
      HTML
    })
    session.visit '/'
    session
  end

  # `[x of #t, width of one space]` — the second is what every stop is a multiple of.
  def measure(body, css = '', probe: ' ')
    s = page(body, css)
    s.evaluate_script(<<~JS)
      (function () {
        var w = document.getElementById('__w');
        w.textContent = #{probe.to_json};
        return [document.getElementById('t').getBoundingClientRect().x, w.getBoundingClientRect().width];
      })()
    JS
  end

  it 'advances to the first stop from the content edge' do
    x, sp = measure("<pre>\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * sp)
  end

  it 'advances to the next stop after text' do
    x, sp = measure("<pre>ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * sp)
  end

  it 'takes the whole next stop when it sits on one' do
    x, sp = measure("<pre>#{' ' * 8}\t<span id=t>X</span></pre>")               # eight spaces = one stop
    expect(x).to be_within(0.01).of(16 * sp)
  end

  it 'advances by two stops for two tabs' do
    x, sp = measure("<pre>\t\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(16 * sp)
  end

  it 'counts tab-size in spaces' do
    x, sp = measure("<pre style=\"tab-size:4\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(4 * sp)
  end

  it 'takes tab-size as a length' do
    _, sp = measure('<pre><span id=t></span></pre>')
    ab = measure("<pre><span id=t>ab</span></pre>", '', probe: 'ab')[1]
    stop = ab + sp                                                       # a whole space short of the stop
    x, = measure("<pre style=\"tab-size:#{stop}px\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(stop)
  end

  it 'skips a stop less than half a space away' do
    _, sp = measure('<pre><span id=t></span></pre>')
    ab = measure("<pre><span id=t>ab</span></pre>", '', probe: 'ab')[1]
    stop = ab + sp / 4                                                   # a quarter space short
    x, = measure("<pre style=\"tab-size:#{stop}px\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(2 * stop)
  end

  it 'measures the stops from the content edge, inside the padding' do
    x, sp = measure("<pre style=\"padding-left:10px\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(10 + 8 * sp)
  end

  it 'does not move the stops with text-indent' do
    x, sp = measure("<pre style=\"text-indent:30px;tab-size:16\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(16 * sp)
  end

  it 'counts from the start of each line' do
    x, sp = measure("<pre>aaaa bbbb\nab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * sp)
  end

  it 'widens the stop by the letter-spacing' do
    x, sp = measure("<pre style=\"letter-spacing:2px\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * (sp + 2))
  end

  it 'widens the stop by the word-spacing' do
    x, sp = measure("<pre style=\"word-spacing:5px\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * (sp + 5))
  end

  it 'gives a tab no width under tab-size: 0' do
    x, = measure("<pre style=\"tab-size:0\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(measure("<pre><span id=t>ab</span></pre>", '', probe: 'ab')[1])
  end

  it 'stops a pre span in the middle of a line from the block edge' do
    x, sp = measure("<div style=\"width:300px;tab-size:16\">aaaa <span style=\"white-space:pre\">b\t<span id=t>X</span></span></div>")
    expect(x).to be_within(0.01).of(16 * sp)
  end

  it 'takes the unit from the block font, not the tab\'s own' do
    big = measure('<pre style="font-size:32px"><span id=t></span></pre>', '#__w { font-size: 32px }')[1]
    x, = measure("<pre style=\"font-size:32px\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * big)
    x, sp = measure("<pre>ab<span style=\"font-size:32px\">\t</span><span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * sp)
  end

  it 'takes the count from the tab\'s own element and the unit from the block' do
    x, sp = measure("<pre style=\"tab-size:8\"><code style=\"tab-size:4;font-size:32px\">a\t<span id=t>X</span></code></pre>")
    expect(x).to be_within(0.01).of(4 * sp)
  end

  it 'drops a percentage tab-size' do
    x, sp = measure("<pre style=\"tab-size:50%\">ab\t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * sp)
    s = page('<pre id=p style="tab-size:50%">a</pre>')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('p')).tabSize")).to eq('8')
  end

  it 'counts an inline\'s opening padding before the tab' do
    x, sp = measure("<pre>ab<span style=\"padding-left:30px;tab-size:16\">\t<span id=t>X</span></span></pre>")
    expect(x).to be_within(0.01).of(16 * sp)
  end

  # Under `pre-wrap` the tab is a white-space TOKEN placed on its own; its width, and the stop it
  # picks, count the letter-spacing the text before it carries (a regression the review caught:
  # the token was summed unspaced).
  it 'places a pre-wrap tab after letter-spaced text at the spaced stop' do
    x, sp = measure("<pre style=\"white-space:pre-wrap;letter-spacing:2px\">a \t<span id=t>X</span></pre>")
    expect(x).to be_within(0.01).of(8 * (sp + 2))
  end

  # ── the painter ──
  it 'paints the text after a tab at the stop' do
    s = page("<pre id=c>cd</pre><pre id=t>ab\tcd</pre>")
    sp = s.evaluate_script("document.getElementById('__w').getBoundingClientRect().width")
    band = ->(id) { s.evaluate_script("(function () { var r = document.getElementById(#{id.to_json}).getBoundingClientRect(); return [Math.floor(r.top), Math.ceil(r.bottom)]; })()") }
    path = File.join(Dir.tmpdir, "csim-tab-#{Process.pid}.png")
    begin
      s.driver.save_screenshot(path)
      img = Vips::Image.new_from_file(path)
      raw = img.write_to_memory
      bands = img.bands
      # The right edge of the ink in each band: "cd" ends one stop later in the tabbed block.
      ink_right = lambda do |(y0, y1)|
        (0...img.width).select {|x| (y0...y1).any? {|y| raw.byteslice(((y * img.width) + x) * bands, 3).bytes[0] < 128 } }.max
      end
      expect(ink_right.call(band.call('t')) - ink_right.call(band.call('c'))).to be_within(1.5).of(8 * sp)
    ensure
      File.delete(path) if File.exist?(path)
    end
  end
end
