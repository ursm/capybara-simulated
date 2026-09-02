# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An ANIMATION is the third place a declaration can come from, beside a rule and a style attribute.
# The value model always knew that — `getComputedStyle` reported the interpolated value — but the
# layout gates did not: `declaresLayoutProp` and `mayConstrainSize` ask a rule index and the
# element's inline map, and a property that only ever appears inside `@keyframes` or in an
# `element.animate()` frame is in neither. So layout read the STATIC cascade and the two views of
# the same element disagreed: an animated `translateX(100px)` reported `matrix(1, 0, 0, 1, 100, 0)`
# from `getComputedStyle` and an untransformed `getBoundingClientRect`, and an animated
# `max-width: 40px` laid out at its full width. Adding a rule that matched nothing at all fixed
# both — the value was there to be asked for all along.
#
# Every figure here is Chrome 151-measured on the same markup.
RSpec.describe 'a value an animation declares reaches layout' do
  def page_with(css, body)
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          .b { width: 100px; height: 50px; background: #ccc }
          #{css}
        </style></head><body>#{body}</body></html>
      HTML
    })
    session.visit '/'
    session
  end

  def rect(session, id = 't')
    session.evaluate_script(<<~JS)
      (function () {
        var r = document.getElementById(#{id.to_json}).getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(function (n) { return Math.round(n * 100) / 100; });
      })()
    JS
  end

  def computed(session, prop, id = 't')
    session.evaluate_script("getComputedStyle(document.getElementById(#{id.to_json}))[#{prop.to_json}]")
  end

  # `paused` at its first keyframe, so what is under test is the GATE and not the clock: the
  # animation's value at time zero is already one no rule declares.
  it 'measures a box where a @keyframes transform puts it' do
    s = page_with('@keyframes k { from { transform: translateX(150px) } to { transform: translateX(200px) } }' \
                  '#t { animation: k 10s linear paused }',
                  '<div class=b id=t></div>')
    expect(computed(s, 'transform')).to eq('matrix(1, 0, 0, 1, 150, 0)')
    expect(rect(s)).to eq([150, 0, 100, 50])
  end

  it 'measures a box where an element.animate() transform puts it' do
    s = page_with('', '<div class=b id=t></div>')
    s.execute_script(<<~JS)
      const a = document.getElementById('t').animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }],
        { duration: 10000, fill: 'forwards' }
      );
      a.currentTime = 5000;
    JS
    expect(computed(s, 'transform')).to eq('matrix(1, 0, 0, 1, 100, 0)')
    expect(rect(s)).to eq([100, 0, 100, 50])
  end

  # Not only `transform`: `mayConstrainSize` is a second gate with the same shape, and a
  # min/max size an animation declares has to reach the box the same way.
  it 'constrains a box by a max-width only an animation declares' do
    s = page_with('@keyframes m { from { max-width: 40px } to { max-width: 40px } }' \
                  '#t { animation: m 10s linear paused }',
                  '<div class=b id=t></div>')
    expect(computed(s, 'maxWidth')).to eq('40px')
    expect(rect(s)).to eq([0, 0, 40, 50])
  end

  # A cancelled animation takes its declaration with it: the live-set generation the document-wide
  # property index is memoised on has to move, or the box stays where the animation left it.
  it 'lets go when the animation is cancelled' do
    s = page_with('', '<div class=b id=t></div>')
    s.execute_script(<<~JS)
      globalThis.__a = document.getElementById('t').animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }],
        { duration: 10000, fill: 'forwards' }
      );
      globalThis.__a.currentTime = 5000;
    JS
    expect(rect(s)).to eq([100, 0, 100, 50])
    s.execute_script('globalThis.__a.cancel()')
    expect(rect(s)).to eq([0, 0, 100, 50])
  end

  # `white-space` and the inherited-property ancestor walk are two more gates written to the same
  # shape, and they were blind in the same way. A 60px monospace box whose only `white-space: pre`
  # comes from an animation does not wrap.
  #
  # Against a CONTROL rather than against a number: a line box's height comes from the `hhea`
  # metrics of whatever face fontconfig resolves `monospace` to, which is not the same face on CI
  # as on this machine — asserting Chrome's 22px here passed locally and turned CI red. And the
  # control declares its `white-space` INLINE, because a rule would put the property in the
  # document-wide index and open the gate for the element under test too.
  it 'stops a box wrapping for a white-space only an animation declares' do
    s = page_with('@keyframes ws { from { white-space: pre } to { white-space: pre } }' \
                  '#t, #c, #n { width: 60px; font: 16px monospace }' \
                  '#t { animation: ws 10s linear paused }',
                  '<div id=t>a b c d e f g h</div>' \
                  '<div id=c style="white-space:pre">a b c d e f g h</div>' \
                  '<div id=n>a b c d e f g h</div>')
    expect(computed(s, 'whiteSpace')).to eq('pre')
    expect(rect(s, 't')[3]).to eq(rect(s, 'c')[3])   # one line, like the unwrapped control
    expect(rect(s, 't')[3]).to be < rect(s, 'n')[3]  # …and not the wrapped one
  end

  it 'inherits a value only an animation on the ancestor declares' do
    s = page_with('@keyframes ls { from { letter-spacing: 10px } to { letter-spacing: 10px } }' \
                  '#p { animation: ls 10s linear paused; font: 16px monospace }',
                  '<div id=p><span id=t>abcd</span></div>')
    # Chrome reports `10px` on the CHILD; the ancestor walk skipped any ancestor no RULE declared
    # the property on, so it reported the initial `normal`. (The span's WIDTH is a separate,
    # pre-existing gap: layout does not apply letter-spacing to a text advance at all — Chrome
    # measures 78.4px against our 38.4px for a plain `letter-spacing: 10px` RULE too.)
    expect(computed(s, 'letterSpacing')).to eq('10px')
  end

  # Every mutation of an effect is a style change for the element it targets — and for the one it
  # STOPS targeting. Each figure below is Chrome-measured on the same markup.
  def midpoint_animation(session, id, to)
    session.execute_script(<<~JS)
      globalThis.__a = document.getElementById(#{id.to_json}).animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(#{to})' }],
        { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
      );
    JS
  end

  it 'lets the box go when the effect is detached' do
    s = page_with('', '<div class=b id=t></div>')
    midpoint_animation(s, 't', '200px')
    expect(rect(s)).to eq([100, 0, 100, 50])
    s.execute_script('globalThis.__a.effect = null')
    expect(computed(s, 'transform')).to eq('none')
    expect(rect(s)).to eq([0, 0, 100, 50])
  end

  it 'follows a replaced effect' do
    s = page_with('', '<div class=b id=t></div>')
    midpoint_animation(s, 't', '200px')
    expect(rect(s)).to eq([100, 0, 100, 50])
    s.execute_script(<<~JS)
      globalThis.__a.effect = new KeyframeEffect(
        document.getElementById('t'),
        [{ transform: 'translateX(0)' }, { transform: 'translateX(400px)' }],
        { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
      );
    JS
    expect(rect(s)).to eq([200, 0, 100, 50])
  end

  it 'moves both boxes when the effect changes target' do
    s = page_with('', '<div class=b id=t></div><div class=b id=u></div>')
    midpoint_animation(s, 't', '200px')
    expect(rect(s, 't')).to eq([100, 0, 100, 50])
    s.execute_script("globalThis.__a.effect.target = document.getElementById('u')")
    expect(computed(s, 'transform', 't')).to eq('none')
    expect(rect(s, 't')).to eq([0, 0, 100, 50])
    expect(rect(s, 'u')).to eq([100, 50, 100, 50])
  end

  # An UNDERLYING transform of its own, or `add` and `replace` compose to the same thing and the
  # example cannot tell them apart. Chrome: 100px before the change, 110px after.
  it 'follows a composite operation change' do
    s = page_with('#t { transform: translateX(10px) }', '<div class=b id=t></div>')
    midpoint_animation(s, 't', '200px')
    expect(rect(s)).to eq([100, 0, 100, 50])
    s.execute_script("globalThis.__a.effect.composite = 'add'")
    expect(computed(s, 'transform')).to eq('matrix(1, 0, 0, 1, 110, 0)')
    expect(rect(s)).to eq([110, 0, 100, 50])
  end

  # …and a keyframe list replaced through the effect has to move it too.
  it 'follows setKeyframes' do
    s = page_with('', '<div class=b id=t></div>')
    s.execute_script(<<~JS)
      globalThis.__a = document.getElementById('t').animate(
        [{ opacity: '1' }, { opacity: '0' }], { duration: 10000, fill: 'forwards' }
      );
      globalThis.__a.currentTime = 5000;
    JS
    expect(rect(s)).to eq([0, 0, 100, 50])
    s.execute_script("globalThis.__a.effect.setKeyframes([{transform:'translateX(0)'},{transform:'translateX(200px)'}])")
    expect(rect(s)).to eq([100, 0, 100, 50])
  end
end
