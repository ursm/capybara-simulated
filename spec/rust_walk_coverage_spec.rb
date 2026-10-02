# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Shapes the Rust walk used to decline, sending the pass to the JS walk (and from there, often, to the oracle): it lays
# each out itself now — and as the JS walk does, box for box, since that is what the pages and the gate were held to.
RSpec.describe 'Rust walk coverage' do
  def page(body)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] })
    s.visit '/'
    s
  end

  BOXES_JS = <<~'JS'
    (() => [...document.querySelectorAll('*')].map((e) => {
      const r = e.getBoundingClientRect();
      return [e.localName, r.x, r.y, r.width, r.height].map((v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v);
    }))()
  JS

  # Every element's box from the Rust walk, then from the JS walk on a page laid out again.
  def both_walks(body, script = nil)
    rust = page(body)
    rust.execute_script(script) if script
    boxes = rust.evaluate_script(BOXES_JS)
    expect(rust.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
    js = page(body)
    js.execute_script('globalThis.__csimRustWalk = false')
    js.execute_script(script) if script
    js.execute_script("document.body.setAttribute('data-relayout', '')")
    [boxes, js.evaluate_script(BOXES_JS)]
  end

  # An element of no namespace the walk knows is the box its style makes it (an `inline` one here — Chrome: 28.81 x 22
  # for "abc" in 16px monospace), where the walk refused every element outside HTML and the svg root. (One named as an
  # HTML element is still declined: the JS model takes it for that element, whatever its namespace.)
  it 'lays a foreign element out as the box its style makes it' do
    script = <<~'JS'
      const u = document.createElementNS('urn:x', 'thing');
      u.textContent = 'abc';
      document.getElementById('b').appendChild(u);
    JS
    rust, js = both_walks('<div id="b" style="font: 16px monospace"></div>', script)
    expect(rust).to eq(js)
    u = rust.find {|b| b[0] == 'thing' }
    expect(u[3]).to be_within(0.02).of(28.81)
    expect(u[4]).to eq(22)
  end

  # An orphan `display: table-row` — of block children, and of bare text — as the JS model lays it out: an equal-share
  # flex row, its text dropped and floored at a line.
  it 'lays out an orphan table row' do
    rust, js = both_walks(
      '<div style="width: 300px; font: 16px monospace"><div style="display: table-row"><div>aa</div><div>bbbb</div></div>' \
      '<div style="display: table-row">text</div><thead style="display: block"><tr><td>cell</td></tr></thead></div>'
    )
    expect(rust).to eq(js)
  end

  # An `<object>` is the default object size where it shows a resource and the box its style makes it where it shows its
  # fallback; an `<embed>` with no resource is no box at all (Chrome, `uaNotRendered`).
  it 'lays out an object, its fallback, and no src-less embed' do
    rust, js = both_walks(
      '<div style="font: 16px monospace"><object data="x.png"></object><object><span>fallback</span></object>' \
      '<embed type="text/plain"><object id="nbsp">&nbsp;</object><p>after</p></div>'
    )
    expect(rust).to eq(js)
    expect(rust.find {|b| b[0] == 'embed' }[3..4]).to eq([0, 0])
    # (…an NBSP is fallback content, not white space: an inline 9.61 wide in Chrome, where the JS model's `\S` made it
    # the 300 x 150 replaced box)
    expect(rust.select {|b| b[0] == 'object' }.last[3]).to be_within(0.02).of(9.61)
  end

  # An intrinsic-size keyword on a replaced element is its intrinsic width, as the JS layout has it; `stretch` is an auto
  # width, a block's filling its containing block.
  it 'lays out keyword widths on controls and a stretch width' do
    rust, js = both_walks(
      '<div style="width: 300px; font: 16px monospace"><input type="date" style="width: min-content">' \
      '<input type="range" style="display: block; width: max-content"><div style="width: stretch; margin: 0 7px">x</div></div>'
    )
    expect(rust).to eq(js)
  end

  # A fixed box inside a TRANSFORMED row or row group has that part for its containing block (Chrome: 11,115 and
  # 53.2,152 for these two), which the walk could not name: a table part's record was in no index.
  it 'lays out a fixed box inside a transformed table part' do
    rust, js = both_walks(
      '<body style="margin: 0; font: 16px monospace"><div style="height: 50px"></div><table style="border-spacing: 4px"><thead><tr><td>head</td></tr></thead>' \
      '<tbody style="transform: translate(0)"><tr><td>row one</td></tr><tr style="transform: translateX(0)"><td>two' \
      '<div id="f1" style="position: fixed; top: 5px; left: 7px; width: 20px; height: 10px"></div></td></tr></tbody>' \
      '<tfoot style="transform: translate(0)"><tr><td>foot<div id="f2" style="position: fixed; bottom: 0; right: 0; width: 20px; height: 10px"></div>' \
      '</td></tr></tfoot></table></body>'
    )
    expect(rust).to eq(js)
    fixed = rust.select {|b| b[0] == 'div' && b[3] == 20 }
    expect(fixed.map {|b| b[1..2] }).to eq([[11, 115], [53.2, 152]])
  end

  # A `<ruby>` is an inline box, its annotation on the line beside its base, as the JS layout has it (Chrome puts the
  # annotation above: a divergence both share).
  it 'lays out ruby markup' do
    rust, js = both_walks('<p style="font: 16px monospace; width: 120px">some text <ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby> more text</p>')
    expect(rust).to eq(js)
  end

  # A face the page adds through the `FontFace` API is measured natively: its `size-adjust` reads 100% — the identity —
  # where it sets none, which was taken for a metric descriptor and declined every such face.
  it 'lays out text in a FontFace face' do
    ahem = File.binread(File.join(__dir__, 'wpt/fonts/Ahem.ttf'))
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [ahem]] if env['PATH_INFO'] == '/Ahem.ttf'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><span id="t" style="font: 20px custom-font, monospace">abc</span>']]
    })
    s.visit '/'
    s.execute_script("document.fonts.add(new FontFace('custom-font', 'url(/Ahem.ttf)')); document.getElementById('t').style.color = 'red';")
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().width")).to eq(60)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # …and an `@font-face` with metric descriptors: its `size-adjust` scales every advance (a face of its own natively,
  # `registerFontScaled`), its overrides the line box — 6 Ahem characters at 20px x 150% are 180 wide.
  it 'lays out text in a face with metric descriptors' do
    ahem = File.binread(File.join(__dir__, 'wpt/fonts/Ahem.ttf'))
    css = '@font-face { font-family: a150; src: url(/Ahem.ttf); size-adjust: 150%; ascent-override: 90%; }'
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [ahem]] if env['PATH_INFO'] == '/Ahem.ttf'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><style>#{css}</style><span id=\"t\" style=\"font: 20px a150, monospace\">abc de</span>"]]
    })
    s.visit '/'
    s.execute_script("document.body.style.color = 'red'")
    expect(s.evaluate_script("document.getElementById('t').getBoundingClientRect().width")).to eq(180)
    expect(s.evaluate_script('JSON.stringify(__csimNativeLayoutStats().rustFellBack)')).to eq('{}')
  end

  # A face whose descriptors change after the first layout is the new face to the style engine's `ch` / `ex` too: the
  # faces it computed a metric from are asked for again once the faces' generation moves, where it kept the old one's.
  it "follows a face's size-adjust into ch and ex when it changes" do
    ahem = File.binread(File.join(__dir__, 'wpt/fonts/Ahem.ttf'))
    html = '<style id="ff">@font-face { font-family: F; src: url(/Ahem.ttf); size-adjust: 150%; }</style>' \
           '<div style="font: 20px F, monospace"><div id="x" style="width: 10ch; height: 3ex"></div><span>abc</span></div>'
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/ttf'}, [ahem]] if env['PATH_INFO'] == '/Ahem.ttf'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body style=\"margin: 0\">#{html}</body>"]]
    })
    s.visit '/'
    read = "(() => { const cs = getComputedStyle(document.getElementById('x')); return [cs.width, cs.height]; })()"
    expect(s.evaluate_script(read)).to eq(%w[300px 72px])
    s.execute_script("document.getElementById('ff').textContent = '@font-face { font-family: F; src: url(/Ahem.ttf); size-adjust: 50%; }'")
    expect(s.evaluate_script(read)).to eq(%w[100px 24px])
  end
end
