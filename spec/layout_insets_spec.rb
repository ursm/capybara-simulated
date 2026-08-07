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
    # Text-only, so the height is the coarse line-height (Chrome measures 18 with real glyphs) —
    # what matters is that an out-of-flow text box has a non-zero, hittable box at the bottom edge.
    expect(rect_of(s, 'tip')).to eq([0, 749, 60, 19])
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

  it 'stretches `inset: 0` across the whole viewport, occluding what is under it' do
    s = session
    # Chrome: 0 0 1024 681 (viewport-filling); ours 768 tall.
    expect(rect_of(s, 'overlay')).to eq([0, 0, 1024, 768])
    # The point of a backdrop: content beneath it is no longer reachable.
    expect(s.find('#rel', visible: :all)).to be_obscured
  end
end
