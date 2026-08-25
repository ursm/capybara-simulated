# frozen_string_literal: true

require 'capybara/simulated'
require 'vips'
require_relative 'support/session_teardown'

# `save_screenshot` rasters the laid-out page (js/src/paint.js) rather than serializing it. There
# is no second geometry: the painter reads the same boxes every geometry query reads, so these
# assert that what the driver BELIEVES about a box is what lands in the pixels.
RSpec.describe 'save_screenshot' do
  def page_with(body, css: '')
    html = %(<!DOCTYPE html><html><head><style>body{margin:0;background:#fff;font:16px sans-serif}#{css}</style></head><body>#{body}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  PNG_MAGIC = "\x89PNG\r\n\x1A\n".b

  def shot(session, **opts)
    path = File.join(Dir.tmpdir, "csim-shot-#{Process.pid}-#{rand(1 << 32)}.png")
    session.driver.save_screenshot(path, **opts)
    img = Vips::Image.new_from_file(path)
    yield img, ->(x, y) { img.getpoint(x, y).map(&:to_i)[0, 3] }, path
  ensure
    File.delete(path) if path && File.exist?(path)
  end

  it 'writes a real PNG the size of the viewport' do
    s = page_with('<div></div>')
    shot(s) do |img, _px, path|
      expect(File.binread(path, 8)).to eq(PNG_MAGIC)
      expect([img.width, img.height]).to eq([1024, 768])
    end
  end

  it 'paints a box where the layout puts it, with its background and border' do
    s = page_with('<div class="box"></div>',
                  css: '.box{width:200px;height:80px;background:rgb(255,0,0);border:4px solid rgb(0,0,255)}')
    shot(s) do |_img, px, _path|
      expect(px.call(2, 40)).to   eq([0, 0, 255])       # inside the 4px border
      expect(px.call(100, 40)).to eq([255, 0, 0])       # the background
      expect(px.call(400, 40)).to eq([255, 255, 255])   # past the box: the page
      expect(px.call(100, 200)).to eq([255, 255, 255])  # below it
    end
  end

  it 'paints text in its own colour, on the line the flow put it on' do
    # The run positions come from the flow itself (`recordingRuns`), so the ink has to land inside
    # the paragraph's own box — which is what a painter that re-derived line breaking would miss.
    s = page_with('<p>Hello painter</p>', css: 'p{color:rgb(0,128,0);margin:0;height:20px}')
    shot(s) do |_img, px, _path|
      inked = (0...300).select {|x| (0...20).any? {|y| c = px.call(x, y); c[1] > 90 && c[0] < 120 && c[2] < 120 } }
      expect(inked).not_to be_empty
      expect(inked.max).to be < 300                     # a 12-character run, not the whole width
      expect(px.call(600, 10)).to eq([255, 255, 255])   # nothing painted past the text
    end
  end

  it 'paints the whole document with full: true' do
    s = page_with('<div class="tall"></div>', css: '.tall{height:2000px;background:rgb(0,0,255)}')
    shot(s) {|img, _px, _path| expect(img.height).to eq(768) }
    shot(s, full: true) do |img, px, _path|
      expect(img.height).to be >= 2000
      expect(px.call(10, 1900)).to eq([0, 0, 255])      # past the viewport, still painted
    end
  end

  it 'follows a scroll offset' do
    s = page_with('<div class="a"></div><div class="b"></div>',
                  css: '.a{height:900px;background:rgb(255,0,0)}.b{height:900px;background:rgb(0,0,255)}')
    s.execute_script('window.scrollTo(0, 900)')
    shot(s) {|_img, px, _path| expect(px.call(10, 10)).to eq([0, 0, 255]) }
  end

  it 'draws a replaced element into its content box' do
    # A 40x40 magenta PNG, inline so the fetch is synchronous.
    png = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAALElEQVR4nO3NMQkAAAwDsPo33Zko7AnkT5q+iFgsFo" \
          "vFYrFYLBaLxWKxWLxzzs50NT7y1u0AAAAASUVORK5CYII="
    s = page_with(%(<img src="data:image/png;base64,#{png}" style="width:100px;height:60px;border:5px solid rgb(0,0,0)">))
    shot(s) do |_img, px, _path|
      expect(px.call(2, 30)).to  eq([0, 0, 0])          # the border
      expect(px.call(50, 30)).to eq([255, 0, 255])      # the bitmap, inside it
      expect(px.call(200, 30)).to eq([255, 255, 255])   # past the element
    end
  end

  it 'clips a box to its scroll container' do
    s = page_with('<div class="sc"><div class="in"></div></div>',
                  css: '.sc{width:100px;height:100px;overflow:hidden}.in{width:400px;height:40px;background:rgb(0,200,0)}')
    shot(s) do |_img, px, _path|
      expect(px.call(50, 20)).to  eq([0, 200, 0])       # inside the scroller
      expect(px.call(200, 20)).to eq([255, 255, 255])   # the 400px child, clipped away
    end
  end

  it 'follows an inner scroller offset' do
    s = page_with('<div class="sc" id="sc"><div class="a"></div><div class="b"></div></div>',
                  css: '.sc{width:100px;height:100px;overflow:auto}' \
                       '.a{height:100px;background:rgb(255,0,0)}.b{height:100px;background:rgb(0,0,255)}')
    s.execute_script("document.getElementById('sc').scrollTop = 100")
    shot(s) {|_img, px, _path| expect(px.call(50, 20)).to eq([0, 0, 255]) }
  end

  it 'paints positioned content above in-flow content, by z-index' do
    # `.over` comes FIRST in the DOM, so tree order alone would bury it.
    s = page_with('<div class="over"></div><div class="under"></div><div class="flow"></div>',
                  css: '.over,.under{position:absolute;left:0;top:0;width:100px;height:100px}' \
                       '.over{background:rgb(0,0,255);z-index:2}.under{background:rgb(255,0,0);z-index:1}' \
                       '.flow{width:100px;height:100px;background:rgb(0,200,0)}')
    shot(s) {|_img, px, _path| expect(px.call(50, 50)).to eq([0, 0, 255]) }
  end

  it 'gives each run the advance the flow reserved, so words keep their gaps' do
    # The rasteriser measures a run differently from the flow — for a system font it reports the
    # rounded ink width, where layout sums the face's own `hmtx` advances. Drawing at the
    # rasteriser's width made words overrun the space after them; the painter condenses to the
    # flow's figure instead. What this pins is that the figure travels with the run at all.
    s = page_with('<p id="p">The painter reads the same boxes</p>', css: 'p{margin:0;font:14px sans-serif}')
    runs = s.evaluate_script('globalThis.__csimPaintRuns()')
    words = runs.map {|r| r['text'] }
    expect(words).to eq(%w[The painter reads the same boxes])
    expect(runs.map {|r| r['width'] }).to all(be > 0)
    # …and each run starts past the end of the one before it: a gap, never an overlap.
    runs.each_cons(2) do |a, b|
      expect(b['x']).to be >= (a['x'] + a['width'])
    end
  end
end
