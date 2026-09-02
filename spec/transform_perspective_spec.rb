# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A perspective is a DIVIDE, and a divide is not something a 2D affine can hold. The geometry chain
# composed one affine per element and flattened each in turn, so three things were out of reach: the
# `perspective()` function's own projection, the `perspective` PROPERTY an ancestor applies to its
# children, and `transform-style: preserve-3d`, where two rotations that cancel in three dimensions
# were each flattened onto the plane first and did not.
#
# The chain carries the 4x4 now and maps a flat box's four corners through the HOMOGRAPHY its first,
# second and fourth columns make — divide and all. Every figure is Chrome 151-measured, as
# `[x, y, width, height]` of a 100x50 box inside a 300x200 wrapper.
RSpec.describe 'perspective reaches the geometry' do
  def rect(wrapper_style, box_style, inner_style = nil)
    inner = inner_style ? %(<div class=b id=t style="#{inner_style}"></div>) : ''
    target = inner_style ? 't' : 'b'
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          .w { width: 300px; height: 200px }
          .b { width: 100px; height: 50px; background: #ccc }
        </style></head><body>
          <div class=w style="#{wrapper_style}"><div class=b id=b style="#{box_style}">#{inner}</div></div>
        </body></html>
      HTML
    })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var r = document.getElementById(#{target.to_json}).getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  # ── the perspective() FUNCTION ──
  it 'divides for a perspective in the element own transform' do
    expect(rect('', 'transform:perspective(400px) rotateY(45deg)')).to eq([11.22, -2.42, 71.27, 54.85])
  end

  it 'divides uniformly for a straight translateZ' do
    expect(rect('', 'transform:perspective(400px) translateZ(100px)')).to eq([-16.67, -8.33, 133.33, 66.67])
  end

  it 'divides for a three-function 3D list' do
    expect(rect('', 'transform:perspective(300px) rotateX(30deg) translateZ(40px)'))
      .to eq([-9.32, -19.97, 118.64, 46.93])
  end

  # ── the perspective PROPERTY on an ancestor ──
  # Distinct from the function: this one is the everyday 3D idiom, and it reached the box not at all.
  it 'applies an ancestor perspective to a rotated child' do
    expect(rect('perspective:500px', 'transform:rotateY(45deg)')).to eq([4.35, -7.61, 85.28, 60.91])
  end

  it 'applies an ancestor perspective to a translated child' do
    expect(rect('perspective:500px', 'transform:translateZ(100px)')).to eq([-37.5, -25, 125, 62.5])
  end

  it 'takes the perspective about its own perspective-origin' do
    expect(rect('perspective:500px;perspective-origin:0 0', 'transform:rotateY(45deg)'))
      .to eq([15.76, 0, 63.96, 53.8])
  end

  it 'composes an ancestor perspective with the ancestor own transform' do
    expect(rect('perspective:400px;transform:translateX(20px)', 'transform:rotateY(30deg)'))
      .to eq([17.15, -6.67, 99.49, 59.61])
  end

  # ── preserve-3d ──
  # The pair CANCELS in three dimensions. Flattening each half in turn left the box a quarter of its
  # width, which is what composing flattened affines does.
  it 'lets two rotations cancel across a preserve-3d boundary' do
    expect(rect('transform-style:preserve-3d;transform:rotateY(60deg)', 'transform:rotateY(-60deg)'))
      .to eq([50, 0, 100, 50])
  end

  it 'flattens the same pair when the parent does NOT preserve 3d' do
    expect(rect('transform:rotateY(60deg)', 'transform:rotateY(-60deg)')).to eq([87.5, 0, 25, 50])
  end

  it 'carries a translateZ through a preserve-3d parent under a perspective' do
    expect(rect('perspective:500px;transform-style:preserve-3d;transform:rotateY(45deg)',
                'transform:translateZ(50px)')).to eq([71.43, -11.11, 78.57, 55.56])
  end

  it 'composes three deep through preserve-3d' do
    expect(rect('perspective:600px;transform-style:preserve-3d;transform:rotateY(30deg)',
                'transform-style:preserve-3d;transform:rotateY(30deg)',
                'transform:rotateY(30deg)')).to eq([56.66, -7.78, 12.57, 61.14])
  end

  it 'flattens at each boundary when nothing preserves 3d' do
    expect(rect('perspective:600px;transform:rotateY(30deg)',
                'transform:rotateY(30deg)',
                'transform:rotateY(30deg)')).to eq([26.46, -3.74, 71.29, 55.48])
  end

  # ── the answer must not depend on READ ORDER ──
  # `transformChain` memoises per element, and the shortcut that reuses an ancestor's answer is only
  # sound where the crossing FLATTENS: `flatten(A · B)` is `flatten(A) · B` on the submatrix the
  # geometry reads iff B is already flat. Across a `preserve-3d` boundary it is not, and taking the
  # shortcut applied the ancestor's flatten one step early. `elementFromPoint` warms ancestors
  # before descendants, so a hit test poisoned itself — nothing that reads only the target can see
  # this, which is why these read the ancestors FIRST.
  def rect_warm(wrapper_style, box_style, inner_style = nil)
    inner = inner_style ? %(<div class=b id=t style="#{inner_style}"></div>) : ''
    target = inner_style ? 't' : 'b'
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          .w { width: 300px; height: 200px }
          .b { width: 100px; height: 50px; background: #ccc }
        </style></head><body>
          <div class=w id=w style="#{wrapper_style}"><div class=b id=b style="#{box_style}">#{inner}</div></div>
        </body></html>
      HTML
    })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        // …every ancestor read FIRST, so each carries a memoised chain by the time the target asks.
        document.getElementById('w').getBoundingClientRect();
        document.getElementById('b').getBoundingClientRect();
        var r = document.getElementById(#{target.to_json}).getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  it 'gives the same answer for a preserve-3d pair however it is read' do
    args = ['transform-style:preserve-3d;transform:rotateY(30deg)', 'transform:rotateY(-30deg)']
    expect(rect(*args)).to eq([13.4, 0, 100, 50])
    expect(rect_warm(*args)).to eq([13.4, 0, 100, 50])
  end

  it 'gives the same answer three deep however it is read' do
    args = ['perspective:600px;transform-style:preserve-3d;transform:rotateY(30deg)',
            'transform-style:preserve-3d;transform:rotateY(30deg)',
            'transform:rotateY(30deg)']
    expect(rect(*args)).to eq(rect_warm(*args))
  end

  # ── a grouping property makes the used `transform-style` flat ──
  # A group is rendered as one image before anything composes with it, so its children cannot share
  # its 3D context. Chrome-measured: the pair below cancels at [50, 0, 100, 50] with nothing else on
  # the parent, and flattens to [87.5, 0, 25, 50] with any of these.
  ['overflow:hidden', 'filter:grayscale(1)', 'opacity:0.5', 'isolation:isolate',
   'mix-blend-mode:multiply', 'clip-path:inset(0)', 'will-change:opacity'].each do |grouping|
    it "flattens a preserve-3d parent that also has #{grouping}" do
      expect(rect("transform-style:preserve-3d;transform:rotateY(60deg);#{grouping}",
                  'transform:rotateY(-60deg)')).to eq([87.5, 0, 25, 50])
    end
  end

  it 'keeps preserve-3d under contain: paint' do
    # …which Chrome does NOT treat as grouping for this purpose (measured twice).
    expect(rect('transform-style:preserve-3d;transform:rotateY(60deg);contain:paint',
                'transform:rotateY(-60deg)')).to eq([50, 0, 100, 50])
  end

  # ── the hit test goes back through the same divide ──
  it 'hit-tests a perspective-projected box on its quad' do
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          .w { width: 300px; height: 200px; perspective: 500px }
          .b { width: 100px; height: 50px; background: #ccc }
        </style></head><body>
          <div class=w><div class=b id=b style="transform:rotateY(45deg)"></div></div>
        </body></html>
      HTML
    })
    session.visit '/'
    # The projected quad spans x 4.35..89.63; a point inside it is the box, one past its right edge
    # is the page behind it — where the UNPROJECTED box would have ended at 100.
    inside  = session.evaluate_script("document.elementFromPoint(80, 25) && document.elementFromPoint(80, 25).id")
    outside = session.evaluate_script("document.elementFromPoint(95, 25) && document.elementFromPoint(95, 25).id")
    expect(inside).to eq('b')
    expect(outside).not_to eq('b')
  end
end
