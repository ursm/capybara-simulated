# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# css-transforms interpolates two transform lists FUNCTION BY FUNCTION, and two different functions
# still pair up when they share a PRIMITIVE: `translateX` and `translateY` are both `translate()`.
# The driver compared function names and gave up, so every such pair flipped discretely and reported
# whichever end the easing was nearer. The arguments have to compute first, too — a length inside a
# transform function is px like any other, and a pair written `50px` against `4em` disagreed about
# units and flipped for that reason instead.
#
# The markup is a 80x80 box with a 40px left border, so its border box is 120 wide and 80 tall, at
# a 15px font. Figures are Chrome 151-measured EXCEPT where an example says otherwise: two of them
# pin what this driver does at a gap it still has, and Chrome does something else there.
RSpec.describe 'interpolating a transform list' do
  def midpoint(from, to)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          #t { width: 80px; height: 80px; border-left: solid 40px blue; font-size: 15px }
        </style></head><body><div id=t></div><script>
          document.getElementById('t').animate(
            { transform: [#{from.to_json}, #{to.to_json}] },
            // The easing is flat at its own midpoint, so the value under test does not depend on
            // where the clock happens to be — the shape WPT's own interpolation reftests use.
            { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
          );
        </script></body></html>
      HTML
    })
    session.visit '/'
    session.evaluate_script("getComputedStyle(document.getElementById('t')).transform")
  end

  it 'pairs translateX with translateY through their shared translate()' do
    # translate(25%, 25%) of a 120x80 border box.
    expect(midpoint('translateX(50%)', 'translateY(50%)')).to eq('matrix(1, 0, 0, 1, 30, 20)')
  end

  it 'pairs a percentage against a length through the same primitive' do
    # translate(25%, 25px).
    expect(midpoint('translateX(50%)', 'translateY(50px)')).to eq('matrix(1, 0, 0, 1, 30, 25)')
  end

  it 'pairs rotate with rotateZ' do
    expect(midpoint('rotate(30deg)', 'rotateZ(90deg)')).to eq('matrix(0.5, 0.866025, -0.866025, 0.5, 0, 0)')
  end

  it 'pairs scaleX with scaleY, each against the identity of the axis it leaves alone' do
    expect(midpoint('scaleX(0.5)', 'scaleY(0.5)')).to eq('matrix(0.75, 0, 0, 0.75, 0, 0)')
  end

  # `skewX` and `skewY` are NOT derived from a `skew()` primitive — the spec's table lists no skew,
  # and Chrome interpolates the pair as matrices instead. Both ends here are the identity, so the
  # matrix path reports the identity; treating them as one primitive rotates the list 180deg.
  it 'does not invent a shared primitive for skewX and skewY' do
    expect(midpoint('skewX(0deg) rotate(0deg)', 'skewY(0deg) rotate(360deg)')).to eq('matrix(1, 0, 0, 1, 0, 0)')
  end

  # NOT Chrome's answer, and deliberately so. Chrome interpolates a pair with no shared primitive as
  # MATRICES — it decomposes both into translate / rotate / scale / skew, mixes those and recomposes
  # — and reports `matrix(2, 0, 0, 1, 25, 0)` here (measured). This driver has no decomposition, so
  # the pair flips discretely and reports the end the easing is nearer. What this example pins is
  # that the primitive table does not INVENT a pairing for two functions that share nothing; the
  # value it asserts is the driver's, and it changes the day decomposition lands.
  it 'leaves a pair with no shared primitive discrete (driver behaviour, not Chrome)' do
    expect(midpoint('translateX(50px)', 'scaleX(3)')).to eq('matrix(3, 0, 0, 1, 0, 0)')
  end

  # The arguments compute before they are mixed.
  it 'mixes a length written in em with one written in px' do
    # 4em at a 15px font is 60px; half way from -50px is 5px.
    expect(midpoint('translateX(-50px)', 'translateX(4em)')).to eq('matrix(1, 0, 0, 1, 5, 0)')
  end

  # Rewriting a rotate pair to `rotate3d` is only useful if the geometry can read the result. The
  # projector took the Z axis alone, so the box measured UNTRANSFORMED for a form the interpolator
  # had just started generating — and the same refusal had always applied to an author-written
  # `rotate3d(0, 1, 0, 60deg)`. Chrome-measured `[x, y, width, height]`.
  def rect_after(from, to)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          #t { width: 80px; height: 80px; border-left: solid 40px blue }
        </style></head><body><div id=t></div><script>
          document.getElementById('t').animate(
            { transform: [#{from.to_json}, #{to.to_json}] },
            { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
          );
        </script></body></html>
      HTML
    })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var b = document.getElementById('t').getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  it 'measures a rotation the pair resolved onto the X axis' do
    expect(rect_after('rotate(0deg)', 'rotateX(90deg)')).to eq([0, 11.72, 120, 56.57])
  end

  it 'measures a rotation the pair resolved onto the Y axis' do
    expect(rect_after('rotateX(0deg)', 'rotateY(90deg)')).to eq([17.57, 0, 84.85, 80])
  end

  it 'resolves a percentage inside a calc() against the box' do
    # `calc(25px + 25%)` on a 120px border box is 55px — the static value the reference of WPT's
    # own interpolation reftest is written with, which the driver used to report back verbatim.
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          #t { width: 80px; height: 80px; border-left: solid 40px blue;
               transform: translateX(calc(25px + 25%)) }
        </style></head><body><div id=t></div></body></html>
      HTML
    })
    session.visit '/'
    expect(session.evaluate_script("getComputedStyle(document.getElementById('t')).transform"))
      .to eq('matrix(1, 0, 0, 1, 55, 0)')
    expect(session.evaluate_script("Math.round(document.getElementById('t').getBoundingClientRect().x)"))
      .to eq(55)
  end

  # …and the same calc, ANIMATED. Only `transformMatrix` had learned to read a nested `calc()`; the
  # endpoint resolver kept its own non-nesting scanner, so the pair flipped discretely — and once
  # the static side could resolve the calc, that discrete result stopped looking unresolved and
  # started reporting a confident wrong number (55px, the endpoint, where Chrome has 27.5).
  it 'resolves a percentage inside a calc() when the value is animated' do
    expect(midpoint('translateX(0px)', 'translateX(calc(25px + 25%))')).to eq('matrix(1, 0, 0, 1, 27.5, 0)')
  end

  # A length keeps its full precision until `transformMatrix` rounds once, to six significant
  # digits. Rounding to four decimals on the way reported 6.66665 where Chrome reports 6.66667.
  it 'does not round a length twice' do
    expect(midpoint('translateX(10pt)', 'translateX(1in)')).to eq('matrix(1, 0, 0, 1, 54.6667, 0)')
  end

  # `scale(2,)` is an invalid declaration. Rewriting the endpoint's text to absolutize its lengths
  # dropped the empty argument and handed the parser a `scale(2)` it accepts, so an invalid keyframe
  # started interpolating (2.5 half way). Chrome drops the keyframe outright and interpolates from
  # the underlying value instead, reporting 2 — this driver flips discretely to the other end, which
  # is a gap of its own (an invalid keyframe should be dropped where it is captured), but it must at
  # least not treat the invalid value as a value.
  it 'does not launder an invalid keyframe into an interpolable one (driver behaviour, not Chrome)' do
    expect(midpoint('scale(2,)', 'scale(3)')).to eq('matrix(3, 0, 0, 3, 0, 0)')
  end

  # The computed value of a 3D list is the matrix, which is where this driver now agrees with Chrome.
  # The SPELLING the interpolation produced is still observable — `commitStyles` writes it into the
  # inline style — and that is what `spec/transform_matrix_spec.rb` pins: the parser matches a name
  # case-insensitively and used to write its lowercased lookup key back, so the committed value read
  # `rotatex(60deg)`, a string no browser writes.
  it 'reports an interpolated 3D rotation as the matrix it composes to' do
    expect(midpoint('rotateX(30deg)', 'rotateX(90deg)'))
      .to eq('matrix3d(1, 0, 0, 0, 0, 0.5, 0.866025, 0, 0, -0.866025, 0.5, 0, 0, 0, 0, 1)')
  end
end
