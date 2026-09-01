# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A transform moves the box a page can MEASURE. It does not move the element in flow — everything
# around it lays out as though it were where it started — but `getBoundingClientRect`,
# `getClientRects` and a hit test all see the transformed quad.
#
# The driver composed a correct matrix for the computed value and then never applied it: a
# `rotate(45deg)` 100×50 box measured 100×50 where Chrome measures 106.07 square, and a click just
# outside the rotated quad still landed on it. Every figure here is Chrome 151-measured.
RSpec.describe 'transform geometry' do
  def page_with(body)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          .b { position: absolute; left: 0; width: 100px; height: 50px; background: #ccc }
        </style></head><body>#{body}</body></html>
      HTML
    })
    session.visit '/'
    session
  end

  # `[x, y, width, height]`, rounded the way the battery reads them.
  def rect(session, id)
    session.evaluate_script(<<~JS)
      (function () {
        var r = document.getElementById(#{id.to_json}).getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  it 'measures a translated box where it was moved to' do
    s = page_with('<div class=b id=t style="top:0;transform:translate(30px,40px)"></div>')
    expect(rect(s, 't')).to eq([30, 40, 100, 50])
  end

  # A percentage translation resolves against the element's OWN border box.
  it 'resolves a percentage translation against the box' do
    s = page_with('<div class=b id=t style="top:0;transform:translate(50%,100%)"></div>')
    expect(rect(s, 't')).to eq([50, 50, 100, 50])
  end

  # A scale and a rotation turn about the transform-origin — the centre by default.
  it 'measures a scaled box about its origin' do
    s = page_with('<div class=b id=a style="top:0;transform:scale(2)"></div>' \
                  '<div class=b id=b style="top:100px;transform:scale(2);transform-origin:0 0"></div>')
    expect(rect(s, 'a')).to eq([-50, -25, 200, 100])
    expect(rect(s, 'b')).to eq([0, 100, 200, 100])
  end

  # …and a rotated box measures the axis-aligned box its quad occupies.
  it 'measures the bounds a rotated quad occupies' do
    s = page_with('<div class=b id=a style="top:0;transform:rotate(45deg)"></div>' \
                  '<div class=b id=b style="top:100px;transform:rotate(90deg);transform-origin:0 0"></div>')
    expect(rect(s, 'a')).to eq([-3.03, -28.03, 106.07, 106.07])
    expect(rect(s, 'b')).to eq([-50, 100, 50, 100])
  end

  # An ancestor's transform applies to its descendants' boxes too, outermost last.
  it 'composes an ancestor transform' do
    s = page_with(<<~HTML)
      <div class=b id=p style="top:0;transform:scale(2);transform-origin:0 0">
        <div style="position:absolute;left:10px;top:5px;width:20px;height:10px" id=k></div>
      </div>
    HTML
    expect(rect(s, 'p')).to eq([0, 0, 200, 100])
    expect(rect(s, 'k')).to eq([20, 10, 40, 20])
  end

  # The INDIVIDUAL transform properties compose before `transform`, in the order css-transforms-2
  # gives them: translate, then rotate, then scale.
  it 'composes translate, rotate and scale before transform' do
    s = page_with('<div class=b id=a style="top:0;translate:10px;rotate:90deg;scale:2"></div>' \
                  '<div class=b id=b style="top:300px;translate:10px;transform:translateX(20px)"></div>')
    expect(rect(s, 'a')).to eq([10, -75, 100, 200])
    expect(rect(s, 'b')).to eq([30, 300, 100, 50])
  end

  # With no perspective in play a 3D rotation is a foreshortening of the other axis, which is what
  # the box on screen measures.
  it 'flattens a 3D rotation' do
    s = page_with('<div class=b id=a style="top:0;transform:rotateY(60deg)"></div>')
    expect(rect(s, 'a')).to eq([25, 0, 50, 50])
  end

  # A hit test asks whether the point is inside the transformed QUAD, not inside its bounds: a
  # point in the corner of a rotated square's bounding box is over whatever is behind it.
  it 'hit-tests through the transform' do
    s = page_with('<div class=b id=a style="top:100px;transform:rotate(45deg)"></div>')
    inside  = s.evaluate_script("(document.elementFromPoint(50, 125) || {}).id")
    corner  = s.evaluate_script("(document.elementFromPoint(6, 78) || {}).id")
    expect(inside).to eq('a')
    expect(corner).not_to eq('a')
  end

  # …and containment is half-open, as a browser hit-tests: the near edges belong to the box, the
  # far ones to whatever is behind it.
  it 'treats the far edges as outside' do
    s = page_with('<div class=b id=a style="top:0"></div>')
    expect(s.evaluate_script("(document.elementFromPoint(99.9, 25) || {}).id")).to eq('a')
    expect(s.evaluate_script("(document.elementFromPoint(100, 25) || {}).id")).not_to eq('a')
    expect(s.evaluate_script("(document.elementFromPoint(50, 50) || {}).id")).not_to eq('a')
  end
end
