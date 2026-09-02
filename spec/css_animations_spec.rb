# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a property reports while a CSS animation or transition is running on it. The value is a
# function of the clock — at the moment it is asked for, the animation's local time says where
# between its keyframes it is — so a `getComputedStyle` read, a layout pass and a paint all get the
# same answer without anything having to be pushed at each frame.
#
# Both batteries seek with a NEGATIVE DELAY (`duration: 100s; delay: -50s`), which is how the WPT
# interpolation harness holds an animation at a fixed progress; every figure is Chrome
# 151-measured on this machine.
RSpec.describe 'CSS animations and transitions' do
  def page(markup)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               @keyframes grow { from { flex-grow: 0 } to { flex-grow: 4 } }
               @keyframes pad  { from { padding-left: 10px } to { padding-left: 50px } }
               @keyframes col  { from { background-color: rgb(0, 0, 0) } to { background-color: rgba(200, 100, 0, 0.5) } }
               @keyframes half { 50% { flex-grow: 3 } }
               @keyframes disc { from { float: left } to { float: right } }
               @keyframes wide { from { width: 10px } to { width: 50% } }
               @keyframes imp  { from { flex-grow: 0 !important } to { flex-grow: 4 } }
               @keyframes kt   { from { flex-grow: 0; animation-timing-function: steps(2, start) } to { flex-grow: 4 } }
               .anim { animation-duration: 100s; animation-delay: -50s; animation-timing-function: linear }
               .quarter { animation-duration: 100s; animation-delay: -25s }
             </style></head><body style="margin:0;font:16px Arial">#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # One animated element, read back through getComputedStyle.
  def animated(style, prop, markup = nil)
    s = page(markup || %(<div id="a" class="anim" style="#{style}"></div>))
    s.evaluate_script(<<~JS)
      getComputedStyle(document.getElementById('a')).getPropertyValue(#{prop.inspect})
    JS
  end

  describe 'CSS Animations' do
    it 'reports the value half way between two keyframes' do
      expect(animated('animation-name:grow', 'flex-grow')).to eq('2')
      expect(animated('animation-name:pad', 'padding-left')).to eq('30px')
    end

    # A colour is eight bits per channel, alpha included, and interpolates with its alpha
    # PREMULTIPLIED — so a fade to a translucent colour doesn't drag through black.
    it 'interpolates a colour premultiplied, at eight bits' do
      expect(animated('animation-name:col', 'background-color')).to eq('rgba(67, 33, 0, 0.753)')
    end

    # A keyframe list that doesn't reach the ends takes the UNDERLYING value there — the one the
    # cascade produced — which is what anchors `animation: pulse` to whatever the page set.
    it 'takes the underlying value at a missing end keyframe' do
      expect(animated('animation-name:half;flex-grow:1', 'flex-grow')).to eq('3')
    end

    # A pair with nothing between them flips at the half-way point instead.
    it 'flips an uninterpolable pair at the half-way point' do
      expect(animated('animation-name:disc', 'float')).to eq('right')
    end

    # Seeking to a QUARTER, where the timing functions differ from each other and from linear —
    # they all agree at the half-way point, which is why the whole battery seeks to 25% here.
    it 'honours the timing function' do
      quarter = ->(style) { animated("animation-name:grow;#{style}", 'flex-grow',
                                     %(<div id="a" class="quarter" style="animation-name:grow;#{style}"></div>)) }
      expect(quarter.call('animation-timing-function:linear')).to eq('1')
      expect(quarter.call('animation-timing-function:steps(2, end)')).to eq('0')
      expect(quarter.call('animation-timing-function:ease-in-out')).to eq('0.516648')
    end

    # …and a keyframe's OWN timing function governs the interval that starts at it, which is a
    # different thing from the animation's.
    it 'honours a keyframe-level timing function' do
      expect(animated('animation-name:kt', 'flex-grow')).to eq('4')
    end

    it 'runs backwards under animation-direction' do
      expect(animated('animation-name:grow;animation-direction:reverse', 'flex-grow',
                      '<div id="a" class="quarter" style="animation-name:grow;animation-timing-function:linear;' \
                      'animation-direction:reverse"></div>')).to eq('3')
      # …and `alternate` turns every odd iteration around: 50s into 40s iterations is the second
      # one, 25% through, which reversed is 75% — 3.
      expect(animated('animation-name:grow;animation-duration:40s;animation-delay:-50s;' \
                      'animation-iteration-count:3;animation-direction:alternate', 'flex-grow')).to eq('3')
    end

    # An animation that has not started yet leaves the element's own value alone; one that fills
    # BACKWARDS holds its first keyframe there instead.
    it 'is not in effect before its delay' do
      expect(animated('animation-name:grow;animation-delay:50s;flex-grow:1', 'flex-grow')).to eq('1')
      expect(animated('animation-name:grow;animation-delay:50s;animation-fill-mode:backwards;flex-grow:1',
                      'flex-grow')).to eq('0')
    end

    # …and one that is OVER holds its last keyframe only while it fills forwards — where a
    # fractional iteration count leaves it part way through the last iteration, not at its end.
    it 'holds where it ended when it fills forwards' do
      expect(animated('animation-name:grow;animation-duration:100s;animation-delay:-150s;' \
                      'animation-fill-mode:forwards', 'flex-grow')).to eq('4')
      expect(animated('animation-name:grow;animation-duration:40s;animation-delay:-200s;' \
                      'animation-iteration-count:2.5;animation-fill-mode:forwards', 'flex-grow')).to eq('2')
      expect(animated('animation-name:grow;animation-duration:100s;animation-delay:-50s;' \
                      'animation-iteration-count:infinite', 'flex-grow')).to eq('2')
    end

    # css-animations §3: an `!important` declaration inside a keyframe is ignored — so the
    # interpolation runs from the UNDERLYING value, not from the one the keyframe named.
    it 'ignores an !important declaration in a keyframe' do
      expect(animated('animation-name:imp;flex-grow:1', 'flex-grow')).to eq('2.5')
    end

    # A keyframe list that names no end at all still interpolates: the ends are the value the
    # element has, which is the shape `@keyframes pulse { 50% { … } }` relies on.
    it 'interpolates out of the underlying value with only a middle keyframe' do
      quarter = '<div id="a" style="animation:half 100s linear -25s"></div>'
      expect(animated(nil, 'flex-grow', quarter)).to eq('1.5')
    end

    # CSS Cascade §6.1: an animation overrides a normal declaration of any origin and loses to an
    # important one.
    it 'loses to an !important declaration' do
      expect(animated('animation-name:grow;flex-grow:2 !important', 'flex-grow')).to eq('2')
    end

    # An animation name resolves in the TREE the animated element lives in (css-scoping §3.3), so a
    # component's `@keyframes` travel with the component.
    it 'finds keyframes declared in the element own shadow tree' do
      s = page('<div id="host"></div>')
      value = s.evaluate_script(<<~JS)
        (function () {
          const sr = document.getElementById('host').attachShadow({mode: 'open'});
          sr.innerHTML = '<style>@keyframes sh { from { flex-grow: 0 } to { flex-grow: 4 } }</style>' +
                         '<div id="inner" style="animation:sh 100s linear -50s"></div>';
          return getComputedStyle(sr.getElementById('inner')).flexGrow;
        })()
      JS
      expect(value).to eq('2')
    end

    # A length and a percentage have no common unit, so the interpolation is a `calc()` — and the
    # element is laid out at what that resolves to.
    it 'interpolates a length with a percentage' do
      markup = '<div style="width:200px"><div id="a" class="anim" style="animation-name:wide"></div></div>'
      expect(animated(nil, 'width', markup)).to eq('55px')
    end
  end

  describe 'CSS Transitions' do
    # A transition is started by a CHANGE: the property computed one value at the last style change
    # event and computes another now. A computed-style read IS that event, exactly as a style
    # recalc is one in a browser.
    def transitioned(prop, from, to, opts = {})
      s = page(opts[:markup] || '<div id="a"></div>')
      s.evaluate_script(<<~JS)
        (function () {
          const el = document.getElementById('a');
          const cs = () => getComputedStyle(el).getPropertyValue(#{prop.inspect});
          el.style.setProperty(#{prop.inspect}, #{from.inspect});
          cs();
          el.style.transitionDuration = '100s';
          el.style.transitionDelay = '-50s';
          el.style.transitionTimingFunction = 'linear';
          el.style.transitionProperty = #{(opts[:property] || prop).inspect};
          #{opts[:behavior] ? "el.style.transitionBehavior = #{opts[:behavior].inspect};" : ''}
          el.style.setProperty(#{prop.inspect}, #{to.inspect});
          return getComputedStyle(el).getPropertyValue(#{(opts[:read] || prop).inspect});
        })()
      JS
    end

    it 'interpolates a property the page changed' do
      expect(transitioned('flex-grow', '1', '3')).to eq('2')
      expect(transitioned('padding-left', '10px', '30px')).to eq('20px')
      expect(transitioned('background-color', 'rgb(0, 0, 0)', 'rgb(100, 200, 40)')).to eq('rgb(50, 100, 20)')
    end

    # …and a length against a percentage lands in the `calc()` between them, laid out at what that
    # resolves to in ITS containing block.
    it 'interpolates a length with a percentage' do
      expect(transitioned('width', '10px', '50%',
                          markup: '<div style="width:400px"><div id="a"></div></div>')).to eq('105px')
    end

    it 'transitions everything under transition-property: all' do
      expect(transitioned('flex-grow', '1', '3', property: 'all')).to eq('2')
    end

    # A property with no interpolation between its values does not transition at all — the new
    # value applies at once — unless the page asks for the discrete flip explicitly.
    it 'leaves a discrete property alone without allow-discrete' do
      expect(transitioned('float', 'left', 'right')).to eq('right')
      expect(transitioned('float', 'left', 'right', behavior: 'allow-discrete')).to eq('right')
    end

    # A SHORTHAND names every longhand under it, and a flow-relative longhand is the same value as
    # its physical twin — so a `padding-inline` transition is visible through `padding-left`, which
    # is the name the layout engine reads. Through the DRIVER's shorthand registry: mdn's tables
    # answer this question with the physical sides a logical shorthand computes to, which armed the
    # wrong edge of the box.
    it 'transitions through a shorthand and a flow-relative twin' do
      expect(transitioned('padding-inline', '10px', '30px', read: 'padding-left')).to eq('20px')
      expect(transitioned('border-block-end', '20px solid', '40px solid',
                          read: 'border-bottom-width')).to eq('30px')
      expect(transitioned('border-block-end', '20px solid', '40px solid',
                          read: 'border-top-width')).to eq('0px')
    end

    # Sending a property back where it came from REVERSES the running transition, shortened so the
    # way back takes no longer than the distance already travelled (css-transitions §3). Hovering
    # off half way through a hover-on is the everyday case. Here the run is interrupted half way,
    # so the reverse covers 5 units in 500ms — one per clock step, where an unshortened 1000ms
    # reverse would step by 0.5.
    it 'shortens a reversed transition' do
      s = page('<div id="a" style="transition:flex-grow 1000ms linear;flex-grow:0"></div>')
      s.execute_script(<<~JS)
        setInterval(() => {}, 1000);            // the page has work, so the clock steps
        const el = document.getElementById('a');
        getComputedStyle(el).flexGrow;
        el.style.flexGrow = '10';
      JS
      out = Array.new(5) { s.evaluate_script("getComputedStyle(document.getElementById('a')).flexGrow").to_f }
      expect(out).to eq([1, 2, 3, 4, 5])
      s.execute_script("document.getElementById('a').style.flexGrow = '0';")
      back = Array.new(3) { s.evaluate_script("getComputedStyle(document.getElementById('a')).flexGrow").to_f }
      expect(back).to eq([5, 4, 3])
    end

    # A property being ANIMATED is not transitioned (css-transitions §3): the animation wins
    # outright, rather than the transition running from the pre-animation value towards it.
    it 'is suppressed by an animation on the same property' do
      s = page('<div id="a" style="flex-grow:1;transition:flex-grow 100s -50s linear;' \
               'animation:grow 100s linear -50s"></div>')
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).flexGrow")).to eq('2')
    end

    # The value is a function of the clock and is therefore never cached: the same read, taken
    # again once the event loop has moved on, reports where the transition has got to. (The clock
    # is the driver's own virtual one — the one the loop advances a step at a time and hands to
    # `requestAnimationFrame` — so this moves deterministically rather than with wall time.)
    it 'is recomputed as the clock advances' do
      s = page('<div id="a"></div>')
      s.execute_script(<<~JS)
        const el = document.getElementById('a');
        el.style.setProperty('flex-grow', '0');
        getComputedStyle(el).flexGrow;
        el.style.transitionDuration = '1000ms';
        el.style.transitionTimingFunction = 'linear';
        el.style.transitionProperty = 'flex-grow';
        el.style.setProperty('flex-grow', '10');
        setInterval(() => {}, 30);          // the page has work, so the clock steps — as a real one does
      JS
      seen = Array.new(4) { s.evaluate_script("getComputedStyle(document.getElementById('a')).flexGrow").to_f }
      expect(seen.uniq.size).to be > 1                     # it moved…
      expect(seen).to eq(seen.sort)                        # …forwards, and only forwards
      expect(seen.last).to be <= 10
    end

    # Every value sampled within one task is sampled at the same moment, as a browser samples its
    # timeline once per update — otherwise two readings of one transitioned value disagree.
    it 'samples one moment for the whole task' do
      s = page('<div id="a"></div>')
      pair = s.evaluate_script(<<~JS)
        (function () {
          const el = document.getElementById('a');
          el.style.setProperty('padding-inline-start', '10px');
          getComputedStyle(el).getPropertyValue('padding-inline-start');
          el.style.transitionDuration = '100s';
          el.style.transitionDelay = '-50s';
          el.style.transitionTimingFunction = 'linear';
          el.style.transitionProperty = 'padding-inline-start';
          el.style.setProperty('padding-inline-start', '30px');
          const cs = getComputedStyle(el);
          return [cs.getPropertyValue('padding-inline-start'), cs.getPropertyValue('padding-left')];
        })()
      JS
      expect(pair).to eq(['20px', '20px'])
    end
  end
  # The live-keyframes filter reads the SHEETS for the names animations reference; a name an
  # element brings in its style attribute is invisible there, and the filter is widened at the
  # attribute write — not when the element's style is first parsed, which for an element nobody
  # has read may be after the keyframe index was built without its name.
  it 'runs an inline animation on an element nobody read' do
    s = page('<style>@keyframes grow { from { width: 100px } to { width: 200px } }</style>' \
             '<div id="a" style="animation: grow 10s linear; width: 50px">a</div>')
    expect(s.evaluate_script("document.getElementById('a').getAnimations().length")).to eq(1)
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).width")).to eq('100px')
  end

end
