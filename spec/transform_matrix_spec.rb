# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A transform list composes into one 4x4 — the only form that holds every function the grammar has.
# The driver used to compose a 2D affine with a `z` translation beside it, and to project a SINGLE
# 3D function for geometry, so a list with two of them or a rotation about a tilted axis reported
# the author's text back and measured untransformed.
#
# Every figure is Chrome 151-measured on the same markup: a 100x50 box.
RSpec.describe 'a transform list composes into one matrix' do
  def styled(css)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          #t { width: 100px; height: 50px; background: #ccc; transform: #{css} }
        </style></head><body><div id=t></div></body></html>
      HTML
    })
    session.visit '/'
    session
  end

  def computed(session) = session.evaluate_script("getComputedStyle(document.getElementById('t')).transform")

  def origin(session)
    session.evaluate_script(<<~JS)
      (function () {
        var b = document.getElementById('t').getBoundingClientRect();
        return [b.x, b.y].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  def size(session)
    session.evaluate_script(<<~JS)
      (function () {
        var b = document.getElementById('t').getBoundingClientRect();
        return [b.width, b.height].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  # ── The computed value ──
  it 'reports a rotation about X as the 4x4 it is' do
    expect(computed(styled('rotateX(60deg)')))
      .to eq('matrix3d(1, 0, 0, 0, 0, 0.5, 0.866025, 0, 0, -0.866025, 0.5, 0, 0, 0, 0, 1)')
  end

  it 'composes a rotation about a TILTED axis' do
    expect(computed(styled('rotate3d(1,1,0,45deg)')))
      .to eq('matrix3d(0.853553, 0.146447, -0.5, 0, 0.146447, 0.853553, 0.5, 0, 0.5, -0.5, 0.707107, 0, 0, 0, 0, 1)')
  end

  it 'composes an arbitrary axis' do
    expect(computed(styled('rotate3d(1,2,3,90deg)')))
      .to eq('matrix3d(0.0714286, 0.944641, -0.320237, 0, -0.658927, 0.285714, 0.695833, 0, ' \
             '0.748808, 0.16131, 0.642857, 0, 0, 0, 0, 1)')
  end

  # TWO 3D functions. The old projector flattened one and gave up on the second, so this list — the
  # identity — reported the author's text and the box measured untransformed.
  it 'composes two 3D functions that cancel' do
    s = styled('rotateX(90deg) rotateX(-90deg)')
    expect(computed(s)).to eq('matrix(1, 0, 0, 1, 0, 0)')
    expect(size(s)).to eq([100, 50])
  end

  it 'composes two 3D functions that do not cancel' do
    s = styled('rotateX(45deg) rotateY(45deg)')
    expect(computed(s)).to eq('matrix3d(0.707107, 0.5, -0.5, 0, 0, 0.707107, 0.707107, 0, ' \
                              '0.707107, -0.5, 0.5, 0, 0, 0, 0, 1)')
    expect(size(s)).to eq([70.71, 85.36])
  end

  it 'composes a 2D function with a 3D one' do
    s = styled('scale(2) rotateY(60deg)')
    expect(computed(s)).to eq('matrix3d(1, 0, -0.866025, 0, 0, 2, 0, 0, 1.73205, 0, 0.5, 0, 0, 0, 0, 1)')
    expect(size(s)).to eq([100, 100])
  end

  it 'reads a matrix3d back' do
    expect(computed(styled('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,30,1)')))
      .to eq('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)')
  end

  it 'keeps a scale on the Z axis in the matrix' do
    expect(computed(styled('scale3d(2,3,4)')))
      .to eq('matrix3d(2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1)')
  end

  # A ZERO Z translation does NOT escalate to the 4x4 form, which is what makes the compositing
  # hint invisible to page code reading a matrix.
  it 'reports a zero Z translation as a 2D matrix' do
    expect(computed(styled('translateZ(0)'))).to eq('matrix(1, 0, 0, 1, 0, 0)')
  end

  it 'reports a non-zero Z translation as a 4x4' do
    expect(computed(styled('translate3d(10px,20px,30px)')))
      .to eq('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)')
  end

  # A zero axis names no rotation, and Chrome computes the identity for it rather than dropping the
  # declaration.
  it 'treats a zero rotation axis as the identity' do
    expect(computed(styled('rotate3d(0,0,0,45deg)'))).to eq('matrix(1, 0, 0, 1, 0, 0)')
  end

  # ── commitStyles ──
  # `commitStyles` writes "the current animated value" into the inline style, and that is the
  # SPECIFIED form — Chrome commits `translateX(25%)` where `getComputedStyle` reports
  # `matrix(1, 0, 0, 1, 25, 0)`, and `rotateX(45deg)` where it reports a matrix3d. The driver
  # committed the computed value, which was invisible for as long as it could not make a matrix out
  # of a 3D list.
  def committed(from, to)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          #t { width: 100px; height: 50px }
        </style></head><body><div id=t></div><script>
          var a = document.getElementById('t').animate(
            { transform: [#{from.to_json}, #{to.to_json}] },
            { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
          );
          a.commitStyles();
        </script></body></html>
      HTML
    })
    session.visit '/'
    session.evaluate_script("document.getElementById('t').style.transform")
  end

  it 'commits the animated value in the form it was written' do
    expect(committed('translateX(0px)', 'translateX(50px)')).to eq('translateX(25px)')
  end

  it 'commits a 3D rotation as a rotation, not as its matrix' do
    expect(committed('rotateX(0deg)', 'rotateX(90deg)')).to eq('rotateX(45deg)')
  end

  it 'commits a three-axis scale' do
    expect(committed('scale3d(1,2,3)', 'scale3d(4,5,6)')).to eq('scale3d(2.5, 3.5, 4.5)')
  end

  # A padded argument neither side wrote is still a LENGTH: Chrome commits `0px`, not `0`.
  it 'writes a padded translate argument in px' do
    expect(committed('translateX(50px)', 'translateZ(50px)')).to eq('translate3d(25px, 0px, 25px)')
  end

  # ── Declarations a browser DROPS ──
  # An empty or extra argument makes the whole declaration invalid. The argument splitter used to
  # discard an empty token, and nothing checked an upper arity, so these composed a real matrix and
  # moved the box. Chrome computes `none` for every one.
  %w[
    scale(2,) skew(10deg,) translate(10px,) translate(,10px) matrix(1,2,3,4,5,6,)
    translateZ(10px,) perspective(500px,) rotate3d(1,1,1,45deg,) translate(10px,20px,30px)
    scale(1,2,3) rotate(45deg,45deg) skewY(10deg,20deg) scaleX(2,3) rotateX(45deg,1)
    translateY(10px,20px) translateX()
  ].each do |value|
    it "drops #{value}" do
      expect(computed(styled(value))).to eq('none')
    end
  end

  # …and the ones that are the wrong KIND of argument rather than the wrong number.
  it 'drops a negative perspective' do
    # The grammar is a non-negative length. `0` and `0.5px` clamp to one pixel; a negative one drops.
    expect(computed(styled('perspective(-1px)'))).to eq('none')
    expect(computed(styled('perspective(0px)')))
      .to eq('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 1)')
  end

  it 'drops a matrix whose arguments are not numbers' do
    expect(computed(styled('matrix(10px,0,0,1,0,0)'))).to eq('none')
    expect(computed(styled('matrix(1,0,0,1,50%,0)'))).to eq('none')
  end

  it 'drops a length that is not one' do
    expect(computed(styled('translateX(10foo)'))).to eq('none')
    expect(computed(styled('translateX(auto)'))).to eq('none')
    expect(computed(styled('translate(10px 20px)'))).to eq('none')
  end

  # The scanner reads `name(args)` and skipped whatever sat between matches.
  it 'drops a list with junk between its functions' do
    expect(computed(styled('none rotate(45deg)'))).to eq('none')
    expect(computed(styled('rotate(45deg) none'))).to eq('none')
  end

  # ── The individual transform properties ──
  # They compose into the same 4x4 as `transform` and are flattened once with it. Their own
  # hand-rolled matrices knew only the cardinal axes, so a tilted `rotate:` measured untransformed —
  # the exact failure the 4x4 exists to kill, surviving in the sibling path.
  def with_property(prop, value)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          #t { width: 100px; height: 50px; background: #ccc; #{prop}: #{value} }
        </style></head><body><div id=t></div></body></html>
      HTML
    })
    session.visit '/'
    session
  end

  it 'measures a tilted rotate: property' do
    expect(size(with_property('rotate', '1 1 0 45deg'))).to eq([92.68, 57.32])
  end

  it 'measures an arbitrary-axis rotate: property' do
    expect(size(with_property('rotate', '1 2 3 90deg'))).to eq([40.09, 108.75])
  end

  # …and they are properties of their own, so `getComputedStyle().transform` stays `none` for them
  # (Chrome-measured). What they move is the box.
  it 'composes a three-axis scale: property' do
    s = with_property('scale', '2 3 4')
    expect(computed(s)).to eq('none')
    expect(size(s)).to eq([200, 150])
  end

  it 'composes a translate: property with a Z component' do
    s = with_property('translate', '10px 20px 30px')
    expect(computed(s)).to eq('none')
    expect(origin(s)).to eq([10, 20])
  end

  # ── Serialization ──
  # Six significant digits, in EXPONENTIAL form once the decimal exponent leaves [-4, 6) — which is
  # what `%g` does, and `perspective(20000px)` is an authorable value that reaches it.
  it 'writes a small component in exponential form' do
    expect(computed(styled('perspective(20000px)')))
      .to eq('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -5e-05, 0, 0, 0, 1)')
  end

  it 'writes a large component in exponential form' do
    expect(computed(styled('scale(1234567)'))).to eq('matrix(1.23457e+06, 0, 0, 1.23457e+06, 0, 0)')
  end

  # The homogeneous `w` is a UNIFORM scale, not anything projective, and the flattening has to
  # divide it out: `w = 2` HALVES the box (Chrome-measured).
  it 'divides the box by the homogeneous w' do
    expect(size(styled('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,2)'))).to eq([50, 25])
    expect(size(styled('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,0.5)'))).to eq([200, 100])
  end

  # ── The box ──
  # Flattening is dropping the Z row and column, which is what a non-preserve-3d parent does: with
  # no perspective in play a `rotateX(60deg)` is exactly a vertical scale by cos 60.
  it 'measures a rotated box flattened onto the plane' do
    expect(size(styled('rotateX(60deg)'))).to eq([100, 25])
  end

  it 'measures a tilted rotation' do
    expect(size(styled('rotate3d(1,1,0,45deg)'))).to eq([92.68, 57.32])
  end

  it 'measures an arbitrary axis' do
    expect(size(styled('rotate3d(1,2,3,90deg)'))).to eq([40.09, 108.75])
  end
end
