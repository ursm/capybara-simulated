require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# `right` / `bottom` insets, and the `inset` shorthand. An out-of-flow box with
# both insets on an axis and an auto size stretches between them — which is what
# makes `position: fixed; inset: 0` (every modal backdrop) actually cover the
# viewport, and so occlude what is under it.
#
# The expected numbers are real Chrome's, read off the same markup with
# `--headless --dump-dom` at a 1024-wide window (only the viewport HEIGHT
# differs there: Chrome's window chrome leaves 681px, ours is a full 768).
RSpec.describe 'layout insets' do
  def body
    <<~HTML
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 }
        #stretch { position: absolute; left: 10px; right: 20px; top: 0; height: 5px }
        #pin { position: fixed; right: 0; bottom: 0; width: 30px; height: 20px }
        #rel { position: relative; right: 10px; bottom: 4px; width: 50px; height: 5px }
        #overlay { position: fixed; inset: 0 }
        #toast { position: fixed; left: 0; bottom: 0; width: 200px }
        #tip { position: absolute; left: 0; bottom: 0; width: 60px }
      </style></head><body>
        <div id="stretch"></div><div id="pin"></div><div id="rel"></div>
        <div id="toast"><div style="height:40px"></div></div>
        <div id="tip">hello</div>
        <div id="inline-pin" style="position:fixed;right:0;bottom:0;width:30px;height:20px"></div>
        <div id="overlay"></div>
      </body></html>
    HTML
  end

  def session
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  def rect_of(s, id)
    s.evaluate_script("(b => [b.x, b.y, b.width, b.height])(document.getElementById('#{id}').getBoundingClientRect())")
  end

  it 'stretches an out-of-flow box between opposite insets' do
    # Chrome: 10 0 994 5 — the auto width is containing block − left − right.
    expect(rect_of(session, 'stretch')).to eq([10, 0, 994, 5])
  end

  it 'positions a sized box against the far edge' do
    # Chrome: 994 661 30 20 (661 = its 681px viewport − 20); ours is 768 − 20.
    expect(rect_of(session, 'pin')).to eq([994, 748, 30, 20])
  end

  it 'shifts a relative box by the opposite-edge insets' do
    # Chrome: -10 -4 50 5 — `right`/`bottom` shift left/up without moving the flow.
    expect(rect_of(session, 'rel')).to eq([-10, -4, 50, 5])
  end

  it 'lifts a bottom-anchored box by the auto height it turns out to have' do
    s = session
    # Chrome: 0 641 200 40 (641 = its 681px viewport − the 40px the child contributes); ours 768−40.
    # The height isn't known until the box's own flow is laid out, so placing it needs a second pass.
    expect(rect_of(s, 'toast')).to eq([0, 728, 200, 40])
    # Text-only, so the height is the font's own line box (18, as Chrome measures) —
    # what matters is that an out-of-flow text box has a non-zero, hittable box at the bottom edge.
    expect(rect_of(s, 'tip')).to eq([0, 750, 60, 18])
  end

  it 'reads insets off the inline `style` attribute, not just stylesheets' do
    # How every popper / toast / dropdown positions itself at runtime (`el.style.bottom = …`).
    # Chrome: 994 661 30 20.
    expect(rect_of(session, 'inline-pin')).to eq([994, 748, 30, 20])
  end

  it 'lets an inline value beat a stylesheet rule for the same inset' do
    s = session
    s.execute_script("document.getElementById('pin').style.right = '100px'")
    expect(rect_of(s, 'pin')).to eq([894, 748, 30, 20])
  end

  it 'insets an anchored box by its own margin, whichever edge it is anchored to' do
    # A margin is part of where an out-of-flow box sits, `auto` or not — and the box has to REPORT
    # the same figure it was placed by. Chrome, in a 400x300 relative containing block:
    # `left: 20; margin-left: 30` sits at 50, and `right: 10; margin-right: 7` at 343 (400−10−40−7).
    markup = <<~HTML
      <div id="cb" style="position:relative;width:400px;height:300px">
        <div id="lead" style="position:absolute;top:10px;left:20px;margin:20px 0 0 30px;width:50px;height:50px"></div>
        <div id="trail" style="position:absolute;bottom:10px;right:10px;margin:0 7px 5px 0;width:40px;height:40px"></div>
        <div id="mid" style="position:absolute;top:0;bottom:0;left:0;height:50px;width:60px;margin:auto"></div>
      </div>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<body style="margin:0">#{markup}</body>)]] })
    s.visit '/'
    expect(rect_of(s, 'lead')).to  eq([50, 30, 50, 50])
    expect(rect_of(s, 'trail')).to eq([343, 245, 40, 40])
    # Between BOTH insets, an `auto` margin takes the slack (§10.6.4) — and reports it: Chrome says
    # `125px`, not `auto` and not `0px`.
    expect(rect_of(s, 'mid')).to eq([0, 125, 60, 50])
    # A box STRETCHED between two insets is that gap less its own margins, on both axes: Chrome
    # makes `inset: 0; margin: 10px` in a 400x300 block 380x280, not 400x300 hanging off both far
    # edges.
    stretch = <<~HTML
      <div id="cb2" style="position:relative;width:400px;height:300px">
        <div id="inset" style="position:absolute;inset:0;margin:10px"></div>
      </div>
    HTML
    s2 = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<body style="margin:0">#{stretch}</body>)]] })
    s2.visit '/'
    expect(rect_of(s2, 'inset')).to eq([10, 10, 380, 280])
    expect(s.evaluate_script("getComputedStyle(document.getElementById('mid')).marginTop")).to eq('125px')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('lead')).marginLeft")).to eq('30px')
  end

  it 'stretches `inset: 0` across the whole viewport, occluding what is under it' do
    s = session
    # Chrome: 0 0 1024 681 (viewport-filling); ours 768 tall.
    expect(rect_of(s, 'overlay')).to eq([0, 0, 1024, 768])
    # The point of a backdrop: content beneath it is no longer reachable.
    expect(s.find('#rel', visible: :all)).to be_obscured
  end
end
