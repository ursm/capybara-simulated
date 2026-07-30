require 'capybara/simulated'
require 'rack'

# Vertical accuracy. Inline content, flex rows, grid rows and table rows all put their children side
# by side; laying each out as a full-width block made every page two to three times too tall, which
# then reported content as being below the fold that a browser has in view (what broke lazy-loading
# and IntersectionObserver-driven rendering).
#
# Every expectation here is real Chrome's, read off the same markup with `--headless --dump-dom` over
# http at 1024x768. Coarse by design, so widths are estimated from text length (no glyph metrics) —
# the assertions below track the numbers we actually produce, and the Chrome value is named whenever
# it differs so the gap is visible rather than forgotten.
RSpec.describe 'layout: inline / flex / grid / table rows' do
  # An 80x40 red PNG, built here so the fixture needs no binary asset.
  PNG_80x40 = begin
    require 'zlib'
    w = 80
    h = 40
    raw = ([0].pack('C') + ([255, 0, 0].pack('C*') * w)) * h
    chunk = lambda {|type, data|
      [data.bytesize].pack('N') + type + data + [Zlib.crc32(type + data)].pack('N')
    }
    "\x89PNG\r\n\x1a\n".b +
      chunk.call('IHDR', [w, h, 8, 2, 0, 0, 0].pack('NNC5')) +
      chunk.call('IDAT', Zlib::Deflate.deflate(raw)) +
      chunk.call('IEND', '')
  end
  def body
    <<~HTML
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0; font: 16px sans-serif }
        #flexrow { display: flex }
        #flexcol { display: flex; flex-direction: column }
        #grid2 { display: grid; grid-template-columns: 1fr 1fr }
        .ib { display: inline-block; width: 100px }
      </style></head><body>
        <div id="inl"><span id="s1">alpha</span><span id="s2">beta</span><span id="s3">gamma</span></div>
        <div id="flexrow"><div id="f1">one</div><div id="f2">two</div></div>
        <div id="flexcol"><div id="c1">one</div><div id="c2">two</div></div>
        <div id="grid2"><div id="g1">left</div><div id="g2">right</div></div>
        <div id="pair"><label id="lb">Name</label><span id="vl">Ada Lovelace</span></div>
        <div id="ibs"><div class="ib" id="b1">1</div><div class="ib" id="b2">2</div></div>
        <div id="txt">Some text with <a id="lnk" href="#">a link</a> inside it.</div>
        <table id="tbl"><tr><td id="td1">r1c1</td><td id="td2">r1c2</td></tr><tr><td id="td3">r2c1</td></tr></table>
        <div id="tail">TAIL</div>
      </body></html>
    HTML
  end

  def session
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  def box(s, id)
    s.evaluate_script(<<~JS)
      (b => [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)])(
        document.getElementById('#{id}').getBoundingClientRect())
    JS
  end

  it 'puts inline siblings on one line' do
    s = session
    # Chrome: the container is 18 tall (our line box is 19 — no glyph metrics), and the spans sit
    # next to each other at x 0 / 39 / 70. Widths come from text length x an average advance.
    expect(box(s, 'inl')).to eq([0, 0, 1024, 19])
    expect(box(s, 's1')).to eq([0, 0, 40, 19])      # Chrome 0,0,39,17
    expect(box(s, 's2')).to eq([40, 0, 32, 19])     # Chrome 39,0,31,17
    expect(box(s, 's3')).to eq([72, 0, 40, 19])     # Chrome 70,0,53,17 ("gamma" has wide glyphs)
  end

  it 'keeps a label and its value on the same line' do
    s = session
    expect(box(s, 'pair')).to eq([0, 95, 1024, 19])   # Chrome 0,90,1024,18 — ONE line, not two
    expect(box(s, 'lb')[0]).to eq(0)
    expect(box(s, 'vl')[0]).to eq(32)                 # Chrome 43 — follows the label, not below it
  end

  it 'flows text and an inline link together' do
    s = session
    expect(box(s, 'txt')).to eq([0, 133, 1024, 19])
    # The link starts after the words before it: Chrome 109, ours 112.
    expect(box(s, 'lnk')[0]).to eq(112)
    expect(box(s, 'lnk')[1]).to eq(133)
  end

  it 'lays a flex row side by side and a flex column stacked' do
    s = session
    expect(box(s, 'flexrow')).to eq([0, 19, 1024, 19])   # Chrome 0,18,1024,18 — one row tall
    expect(box(s, 'f1')[0]).to eq(0)
    expect(box(s, 'f2')[0]).to eq(24)                    # Chrome 27 — beside f1
    # `flex-direction: column` is what block flow already does.
    expect(box(s, 'flexcol')).to eq([0, 38, 1024, 38])   # Chrome 0,36,1024,36
    expect(box(s, 'c2')[0]).to eq(0)
  end

  it 'sizes an auto grid row from its content' do
    s = session
    # Chrome: 18 tall. This used to answer a flat 100px per row, which inflated every grid.
    expect(box(s, 'grid2')).to eq([0, 76, 1024, 19])
    expect(box(s, 'g1')[0]).to eq(0)
    expect(box(s, 'g2')[0]).to eq(512)
  end

  it 'puts table cells in a row beside each other' do
    s = session
    # Chrome: 46 tall for two rows. Coarse: cells divide the row evenly (no content-driven column
    # sizing), so the widths differ from Chrome's shrink-to-fit 33s — the ROW COUNT is the point.
    expect(box(s, 'tbl')[3]).to eq(38)
    expect(box(s, 'td1')[0]).to eq(0)
    expect(box(s, 'td2')[0]).to eq(512)
    expect(box(s, 'td3')[1]).to eq(171)   # second row, below the first
  end

  # Chrome, same markup: a failed-to-load `<img>` with no attributes is 16x16 (its broken-image
  # box), width/height attributes win over that, and a decoded image is its natural size. Verified
  # with `--headless --dump-dom`; the driver records the decoded size as `naturalWidth`/`Height`.
  it 'sizes an image from its natural size, its attributes, or the broken-image box' do
    app = lambda {|env|
      if env['PATH_INFO'] == '/real.png'
        [200, {'content-type' => 'image/png'}, [PNG_80x40]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><html><head><style>body{margin:0}</style></head><body>
            <p><img id="broken" src="/nope.png"></p>
            <p><img id="sized" src="/nope.png" width="120" height="60"></p>
            <p><img id="ratio" src="/real.png" width="160"></p>
            <p><img id="real" src="/real.png"></p>
          </body></html>
        HTML
      end
    }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'

    expect(box(s, 'broken')[2, 2]).to eq([16, 16])     # Chrome: 16x16
    expect(box(s, 'sized')[2, 2]).to eq([120, 60])     # Chrome: 120x60 — attributes win
    expect(box(s, 'real')[2, 2]).to eq([80, 40])       # Chrome: 80x40 — the decoded size
    expect(box(s, 'ratio')[2, 2]).to eq([160, 80])     # one axis given → the other keeps 2:1
  end

  it 'lands the end of the page where a browser does' do
    s = session
    # THE measurement that matters: after all of the above, the last element is at Chrome's exact y.
    # Before this pass it was at 385 — twice as far down — so anything lazy below it never loaded.
    expect(box(s, 'tail')[1]).to eq(190)
    # A document shorter than the window is still viewport-tall, as in a browser.
    expect(s.evaluate_script('document.documentElement.scrollHeight')).to eq(768)
  end
end
