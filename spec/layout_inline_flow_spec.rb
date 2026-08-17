require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

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

  # An 80x40 red PNG, built here so the fixture needs no binary asset. A method, not a constant:
  # a constant assigned inside a `describe` block lands at TOP LEVEL and leaks across the suite.
  def png_80x40
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
    s = simulated_session(app)
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
    # Chrome-exact now that runs are measured with the font's own advances: the
    # container is one 18px line box and the spans sit at x 0 / 39 / 70, each as
    # tall as the font's content box (17).
    expect(box(s, 'inl')).to eq([0, 0, 1024, 18])
    expect(box(s, 's1')).to eq([0, 0, 39, 17])
    expect(box(s, 's2')).to eq([39, 0, 31, 17])
    expect(box(s, 's3')).to eq([70, 0, 53, 17])     # "gamma" really is that much wider
  end

  it 'keeps a label and its value on the same line' do
    s = session
    expect(box(s, 'pair')).to eq([0, 90, 1024, 18])   # ONE line, not two
    expect(box(s, 'lb')[0]).to eq(0)
    expect(box(s, 'vl')[0]).to eq(43)                 # follows the label, not below it
  end

  it 'flows text and an inline link together' do
    s = session
    expect(box(s, 'txt')).to eq([0, 126, 1024, 18])
    # The link starts after the words before it — including the collapsed space.
    expect(box(s, 'lnk')[0]).to eq(109)
    expect(box(s, 'lnk')[1]).to eq(126)
  end

  it 'lays a flex row side by side and a flex column stacked' do
    s = session
    expect(box(s, 'flexrow')).to eq([0, 18, 1024, 18])   # one row tall
    expect(box(s, 'f1')[0]).to eq(0)
    expect(box(s, 'f2')[0]).to eq(27)                    # beside f1
    # `flex-direction: column` is what block flow already does.
    expect(box(s, 'flexcol')).to eq([0, 36, 1024, 36])
    expect(box(s, 'c2')[0]).to eq(0)
  end

  # Chrome, same markup at 1024x768. `flex: 1` twice in a 600px row is 300/300 whatever the words
  # inside are (the shorthand sets `flex-basis: 0`), `flex: 2` + `flex: 1` is 400/200, a fixed item
  # keeps its width and the grower takes the rest, and bare `flex-grow` starts from CONTENT so 1:3
  # over the leftover gives 154/446. The overflowing row shrinks by `flex-shrink x base`, never
  # below an item's automatic minimum — without that half, a row of fixed items pushed its siblings
  # off the line and took a good part of Avo's suite with it.
  it 'distributes a flex row by grow, and takes space back by shrink' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0;font:16px sans-serif}
        .row{display:flex;width:600px}
        #a{flex:1}#b{flex:1}#c{flex:2}#d{flex:1}#e{flex:1}#f{width:150px}#g{flex-grow:1}#h{flex-grow:3}
        #i{width:500px}#j{width:400px}
      </style></head><body>
        <div class="row"><div id="a">a</div><div id="b">b</div></div>
        <div class="row"><div id="c">c</div><div id="d">d</div></div>
        <div class="row"><div id="e">e</div><div id="f">fixed</div></div>
        <div class="row"><div id="g">g</div><div id="h">h</div></div>
        <div class="row"><div id="i">i</div><div id="j">j</div></div>
      </body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    widths = s.evaluate_script(<<~JS)
      ['a','b','c','d','e','f','g','h'].map(i => {
        const r = document.getElementById(i).getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.width)].join(',');
      })
    JS
    expect(widths).to eq(['0,300', '300,300', '0,400', '400,200', '0,450', '450,150', '0,154', '154,446'])
    # 500 + 400 into 600: both shrink in proportion to their base, and the row still fits.
    over = s.evaluate_script("['i','j'].map(i => Math.round(document.getElementById(i).getBoundingClientRect().width))")
    expect(over.sum).to be <= 600
    expect(over.first).to be > over.last
  end

  # Chrome, same markup. `row-reverse` runs the main axis the other way — reverse order AND packed
  # against the right edge — and a text-heavy item shrinks past its text because `min-width: auto`
  # is the MIN-CONTENT width (the longest word), not everything it holds. Measuring the whole text
  # instead left Redmine's `#content` unshrinkable, which pushed its sidebar (and the heading an
  # IntersectionObserver was watching) off the right edge of the viewport.
  it 'reverses and right-packs a row-reverse flex row, and shrinks past text' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0;font:16px sans-serif}
        #main{display:flex;flex-direction:row-reverse;width:600px}
        #side{flex-shrink:0;width:150px}
        #rev{display:flex;flex-direction:row-reverse;width:400px}
        #r1{width:100px}#r2{width:100px}
      </style></head><body>
        <div id="main"><div id="content">#{'word ' * 30}</div><div id="side">side</div></div>
        <div id="rev"><div id="r1">one</div><div id="r2">two</div></div>
      </body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    # Chrome: content=150,450 side=0,150 — the sidebar keeps its width on the right, the text pane
    # shrinks into what is left instead of overflowing.
    expect(box(s, 'side')[0, 3]).to eq([0, 0, 150])
    expect(box(s, 'content')[0]).to eq(150)
    expect(box(s, 'content')[2]).to eq(450)
    # Chrome: r1=300 r2=200 — reversed AND packed against the end, not laid out from x=0.
    expect(box(s, 'r1')[0]).to eq(300)
    expect(box(s, 'r2')[0]).to eq(200)
  end

  it 'sizes an auto grid row from its content' do
    s = session
    # Chrome-exact: one 18px line box. This used to answer a flat 100px per row.
    expect(box(s, 'grid2')).to eq([0, 72, 1024, 18])
    expect(box(s, 'g1')[0]).to eq(0)
    expect(box(s, 'g2')[0]).to eq(512)
  end

  # Chrome-exact, same markup: the table shrinks to its content (72 wide, not the 1024 a block
  # would take), each column is as wide as its own cells, and the cells carry the UA padding and
  # border-spacing. This used to divide the row evenly among the cells and skip both, which put
  # `td2` at x=512 and made the table two bare line boxes tall.
  it 'puts table cells in a row beside each other' do
    s = session
    expect(box(s, 'tbl')).to eq([0, 144, 72, 46])
    expect(box(s, 'td1')).to eq([2, 146, 33, 20])
    expect(box(s, 'td2')).to eq([37, 146, 33, 20])
    expect(box(s, 'td3')[1]).to eq(168)   # second row, below the first
  end

  # Chrome, same markup: a failed-to-load `<img>` with no attributes is 16x16 (its broken-image
  # box), width/height attributes win over that, and a decoded image is its natural size. Verified
  # with `--headless --dump-dom`; the driver records the decoded size as `naturalWidth`/`Height`.
  it 'sizes an image from its natural size, its attributes, or the broken-image box' do
    app = lambda {|env|
      if env['PATH_INFO'] == '/real.png'
        [200, {'content-type' => 'image/png'}, [png_80x40]]
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
    s = simulated_session(app)
    s.visit '/'

    expect(box(s, 'broken')[2, 2]).to eq([16, 16])     # Chrome: 16x16
    expect(box(s, 'sized')[2, 2]).to eq([120, 60])     # Chrome: 120x60 — attributes win
    expect(box(s, 'real')[2, 2]).to eq([80, 40])       # Chrome: 80x40 — the decoded size
    expect(box(s, 'ratio')[2, 2]).to eq([160, 80])     # one axis given → the other keeps 2:1
  end

  # Cases a code review found by building counter-examples; every number below is real Chrome's.
  it 'paints content with the stacking context it lives in' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0}
        #bar{position:fixed;top:0;left:0;width:200px;height:40px;z-index:10}
        #btn{width:100px;height:40px}
        #under{position:absolute;top:0;left:0;width:300px;height:60px;z-index:5}
      </style></head><body><div id="under"></div><div id="bar"><div id="btn">btn</div></div></body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    # The static button inside the z-index:10 bar is painted AT 10, so it beats the z-index:5 box —
    # and the bar does not swallow the click meant for its own content either. Chrome: btn.
    expect(s.evaluate_script("(e => e && e.id)(document.elementFromPoint(50, 20))")).to eq('btn')
  end

  # `position: sticky` scrolls with its container until it reaches the offset it was given, then
  # stays there while the content keeps scrolling under it — as far as the end of its containing
  # block. Every number below is Chrome 137-measured. Without it a sticky sidebar scrolled off the
  # top of the viewport: a click on one of its links "scrolled it into view" and threw the page's
  # scroll position away.
  it 'sticks a box to its scrollport until its containing block runs out' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0;font:16px sans-serif}
        #hdr{position:sticky;top:10px;height:40px}
        #inner{height:300px}
        #tall{height:2000px}
      </style></head><body><div id="inner"><div id="hdr">header</div></div><div id="tall"></div></body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    # Chrome: 10, 10, -240. Its flow position is 0, so the offset holds it at 10 from the start;
    # at 500 its containing block (300 tall) has scrolled past and takes it with it.
    expect(box(s, 'hdr')[1]).to eq(10)
    s.execute_script('window.scrollTo(0, 100)')
    expect(box(s, 'hdr')[1]).to eq(10)
    s.execute_script('window.scrollTo(0, 500)')
    expect(box(s, 'hdr')[1]).to eq(-240)
  end

  # `scroll-margin` is the gap a page asks to be left around a box when something scrolls to it —
  # how a site with a fixed header keeps an anchor target from landing under it. Chrome measured on
  # this markup: `scrollIntoView()` stops at 1150 of a 1200px offset, leaving the target's top at
  # exactly the 50px the page asked for.
  it 'leaves a box its scroll-margin when scrolling to it' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0}
        #hdr{position:fixed;top:0;left:0;right:0;height:50px}
        #pad{height:1200px}
        #t{scroll-margin-top:50px;height:30px}
        #rest{height:1500px}
      </style></head><body><div id="hdr">h</div><div id="pad"></div><div id="t">target</div>
      <div id="rest"></div></body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    s.execute_script("document.getElementById('t').scrollIntoView()")
    expect(s.evaluate_script('Math.round(window.scrollY)')).to eq(1150)
    expect(box(s, 't')[1]).to eq(50)
  end

  it 'does not stretch an inline box around its absolutely positioned content' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0;font:16px sans-serif}
        a{position:relative}
        .menu{position:absolute;left:600px;top:40px;width:200px;height:100px}
      </style></head><body><a id="one">One<div class="menu"></div></a><a id="two">Two</a></body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    # Chrome: one=0,30 two=30,29 — the dropdown is out of flow, so the link stays one word wide and
    # the next link sits beside it (it used to be pushed to x=800).
    expect(box(s, 'one')[2]).to be < 60
    expect(box(s, 'two')[0]).to eq(box(s, 'one')[2])
  end

  it 'keeps replaced elements and controls their own size in a flex row' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [<<~HTML]] }
      <!DOCTYPE html><html><head><style>
        body{margin:0;font:16px sans-serif}
        .frow{display:flex;width:600px}
        #fa{flex:2;width:100px}#fb{flex:1}
        table{width:600px}#c1{width:100px}
      </style></head><body>
        <div class="frow"><input id="inp"><button id="btnf">Go</button></div>
        <div class="frow"><div id="fa">a</div><div id="fb">b</div></div>
        <table><tr><td id="c1">c1</td><td id="c2">c2</td></tr></table>
      </body></html>
    HTML
    s = simulated_session(app)
    s.visit '/'
    # A control in a flex row keeps its intrinsic size instead of being measured as text
    # (Chrome: input 185, button 34 — ours uses the same measured control sizes).
    expect(box(s, 'inp')[2]).to eq(185)
    expect(box(s, 'btnf')[0]).to eq(185)
    # `flex: 2` sets `flex-basis: 0`, which OUTRANKS the declared width — Chrome: 400/200.
    expect(box(s, 'fa')[2]).to eq(400)
    expect(box(s, 'fb')[2]).to eq(200)
    # A table cell is not a flex item: its declared width stands, and the column it sizes takes
    # no part in sharing out the table's surplus width — Chrome: 102, the declared 100 plus the
    # UA cell padding, while its auto neighbour absorbs everything left.
    expect(box(s, 'c1')[2]).to eq(102)
  end

  it 'lands the end of the page where a browser does' do
    s = session
    # THE measurement that matters: after all of the above, the last element lands on Chrome's
    # exact y. Before the box model it was at 385 — twice as far down — so anything lazy below it
    # never loaded; the last 10px of the gap was the unmodelled table.
    expect(box(s, 'tail')[1]).to eq(190)
    # A document shorter than the window is still viewport-tall, as in a browser.
    expect(s.evaluate_script('document.documentElement.scrollHeight')).to eq(768)
  end
end
