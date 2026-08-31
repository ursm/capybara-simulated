# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# How two values of a LIST-valued property are combined — shadows, filters and transforms — and
# what `composite: add` / `accumulate` do with them. These are the properties pages actually
# animate, and until now each of them flipped discretely at the half-way point.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'CSS interpolation types' do
  def page(markup, style = '')
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               body { margin: 0; color: rgb(0, 255, 0) }
               div { width: 100px; height: 100px }
               #{style}
             </style></head><body>#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # Half way through an animation between the two values, read back as the computed value.
  def midpoint(prop, from, to, opts = {})
    s = page(%(<div id="a" style="#{opts[:style]}"></div>), opts[:sheet].to_s)
    s.evaluate_script(<<~JS)
      (function () {
        const el = document.getElementById('a');
        const anim = el.animate([{ #{opts[:composite] ? "composite: #{opts[:composite].inspect}, " : ''}#{prop.inspect}: #{from.inspect} },
                                 { #{opts[:composite] ? "composite: #{opts[:composite].inspect}, " : ''}#{prop.inspect}: #{to.inspect} }],
                                { duration: 1000, fill: 'both'#{opts[:easing] ? ", easing: #{opts[:easing].inspect}" : ''} });
        anim.pause();
        anim.currentTime = 500;
        return getComputedStyle(el).getPropertyValue(#{cssName(prop).inspect});
      })()
    JS
  end

  def cssName(idl) = idl.gsub(/[A-Z]/) { |m| "-#{m.downcase}" }

  # …and half way between two keyframes that composite DIFFERENTLY.
  def mixed(prop, from, from_composite, to, to_composite, style)
    s = page(%(<div id="a" style="#{style}"></div>))
    s.evaluate_script(<<~JS)
      (function () {
        const el = document.getElementById('a');
        const anim = el.animate([{ #{prop.inspect}: #{from.inspect}, composite: #{from_composite.inspect} },
                                 { #{prop.inspect}: #{to.inspect}, composite: #{to_composite.inspect} }],
                                { duration: 1000, fill: 'both' });
        anim.pause();
        anim.currentTime = 500;
        return getComputedStyle(el).getPropertyValue(#{cssName(prop).inspect});
      })()
    JS
  end

  describe 'shadow lists' do
    # A shadow list interpolates COMPONENTWISE, and `none` is a list of zero shadows — so it
    # interpolates against each entry's identity, a transparent shadow with every length at zero.
    it 'interpolates each shadow against its opposite number' do
      expect(midpoint('boxShadow', 'rgb(0,0,0) 0px 0px 0px 0px', 'rgb(100,100,100) 10px 10px 10px 0px'))
        .to eq('rgb(50, 50, 50) 5px 5px 5px 0px')
      expect(midpoint('boxShadow', 'none', 'rgba(100,100,100,1) 10px 10px 10px 0px'))
        .to eq('rgba(100, 100, 100, 0.5) 5px 5px 5px 0px')
    end

    # A shorter list is padded with that identity too, so the lists always line up.
    it 'pads the shorter list' do
      expect(midpoint('boxShadow', 'rgb(200,200,200) 20px 20px 20px 20px',
                      'rgb(100,100,100) 10px 10px 10px 0px, rgb(100,100,100) 10px 10px 10px 0px'))
        .to eq('rgb(150, 150, 150) 15px 15px 15px 10px, rgba(100, 100, 100, 0.5) 5px 5px 5px 0px')
    end

    # `currentcolor` is the element's own colour, resolved before anything is mixed.
    it 'resolves currentcolor first' do
      expect(midpoint('boxShadow', 'currentcolor 0px 0px 0px 0px', 'rgb(0,255,0) 10px 10px 10px 10px'))
        .to eq('rgb(0, 255, 0) 5px 5px 5px 5px')
    end

    # …and each property serializes with the lengths it actually takes: a `text-shadow` has an
    # offset and a blur, a `box-shadow` a spread as well.
    it 'serializes each shadow with its own lengths' do
      expect(midpoint('textShadow', 'rgb(0,0,0) 0px 0px 0px', 'rgb(100,100,100) 10px 10px 10px'))
        .to eq('rgb(50, 50, 50) 5px 5px 5px')
    end
  end

  describe 'filter lists' do
    # Each function against its opposite number, and `none` against each function's OWN identity —
    # zero for a blur, one for a brightness.
    it 'interpolates each function against its identity' do
      expect(midpoint('filter', 'blur(0px)', 'blur(10px)')).to eq('blur(5px)')
      expect(midpoint('filter', 'none', 'blur(10px) brightness(0.5)')).to eq('blur(5px) brightness(0.75)')
    end
  end

  describe 'transforms' do
    # Componentwise where the lists name the same functions, `none` standing for each function's
    # identity — reported as the matrix a page reads back.
    it 'interpolates a matching function list' do
      expect(midpoint('transform', 'translateX(0px)', 'translateX(100px)')).to eq('matrix(1, 0, 0, 1, 50, 0)')
      expect(midpoint('transform', 'none', 'translateX(100px)')).to eq('matrix(1, 0, 0, 1, 50, 0)')
      expect(midpoint('transform', 'translateX(0px) scale(1)', 'translateX(100px) scale(3)'))
        .to eq('matrix(2, 0, 0, 2, 50, 0)')
      expect(midpoint('transform', 'rotate(0deg)', 'rotate(90deg)'))
        .to eq('matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)')
    end

    # Two lists naming DIFFERENT functions are the gap: the spec decomposes each into translate /
    # rotate / scale / skew and interpolates those. `transformMatrix` already composes the matrix,
    # so what is missing is the DECOMPOSITION — a backlog item, not a wall — and until it lands
    # these flip discretely. Chrome reports `matrix(2, 0, 0, 2, 0, 0)` here.
    it 'flips a mismatched function list discretely (a listed gap)' do
      expect(midpoint('transform', 'translateX(0px)', 'scale(3)')).to eq('matrix(3, 0, 0, 3, 0, 0)')
    end
  end

  describe 'composite operations' do
    # A number, a length and a colour ADD to the value underneath.
    it 'sums a numeric or colour value with the underlying one' do
      expect(midpoint('marginLeft', '0px', '20px', composite: 'add', style: 'margin-left:10px')).to eq('20px')
      expect(midpoint('opacity', '0', '0.4', composite: 'add', style: 'opacity:0.5')).to eq('0.7')
      expect(midpoint('backgroundColor', 'rgb(0,0,0)', 'rgb(100,100,100)',
                      composite: 'add', style: 'background-color:rgb(10,20,30)')).to eq('rgb(60, 70, 80)')
    end

    # A LIST adds by CONCATENATION — the underlying list, then the effect's.
    it 'concatenates a list with the underlying one' do
      expect(midpoint('boxShadow', 'rgb(0,0,0) 0px 0px 0px 0px', 'rgb(100,100,100) 10px 10px 10px 10px',
                      composite: 'add', style: 'box-shadow: rgb(10,10,10) 1px 1px 1px 1px'))
        .to eq('rgb(10, 10, 10) 1px 1px 1px 1px, rgb(50, 50, 50) 5px 5px 5px 5px')
      expect(midpoint('filter', 'blur(0px)', 'blur(10px)', composite: 'add', style: 'filter: blur(1px)'))
        .to eq('blur(1px) blur(5px)')
      expect(midpoint('transform', 'translateX(0px)', 'translateX(100px)',
                      composite: 'add', style: 'transform: translateX(10px)'))
        .to eq('matrix(1, 0, 0, 1, 60, 0)')
    end

    # ACCUMULATION is not addition for a list: entries that line up combine, and where they do not
    # line up at all the effect's value replaces.
    it 'accumulates entry by entry, and replaces where they do not line up' do
      expect(midpoint('filter', 'blur(0px)', 'blur(10px)',
                      composite: 'accumulate', style: 'filter: blur(1px)')).to eq('blur(6px)')
      expect(midpoint('filter', 'brightness(1)', 'brightness(1)',
                      composite: 'accumulate', style: 'filter: blur(1px)')).to eq('brightness(1)')
    end

    # Addition is only defined where the type supports it. A track list is not a number just
    # because it holds one, and mdn types `font-variation-settings` as a transform — neither adds.
    it 'leaves a type that does not add alone' do
      expect(midpoint('gridAutoColumns', '1px', '1px', composite: 'add', style: 'grid-auto-columns:5px'))
        .to eq('1px')
    end
  end
  # An easing that overshoots — the "back" easings every UI library ships — drives a value PAST its
  # endpoints, and what stops it there is the value's own range rather than the progress.
  UNDERSHOOT = 'cubic-bezier(0, -2, 1, 1)'
  OVERSHOOT  = 'cubic-bezier(0, 0, 1, 3)'

  describe 'ranges' do
    # Every filter function floors at zero; the four that are PROPORTIONS also cap at one, while
    # the gain functions have no ceiling at all (Chrome-measured, all four).
    it 'clamps a filter function to its own range' do
      expect(midpoint('filter', 'blur(0px)', 'blur(100px)', easing: UNDERSHOOT)).to eq('blur(0px)')
      expect(midpoint('filter', 'brightness(0)', 'brightness(1)', easing: UNDERSHOOT)).to eq('brightness(0)')
      expect(midpoint('filter', 'grayscale(0)', 'grayscale(1)', easing: OVERSHOOT)).to eq('grayscale(1)')
    end

    # In a shadow only the BLUR has a floor: an offset and a spread are real negative lengths.
    it 'lets a shadow offset go negative but not its blur' do
      expect(midpoint('boxShadow', 'rgb(0,0,0) 0px 0px 0px 0px', 'rgb(0,0,0) 40px 40px 40px 40px',
                      easing: UNDERSHOOT))
        .to eq('rgb(0, 0, 0) -10px -10px 0px -10px')
    end

    # Past an OPAQUE endpoint the channels go on climbing: the alpha clamps at 1 before the colour
    # un-premultiplies, or dividing by it would undo the extrapolation.
    it 'extrapolates a colour past an opaque endpoint' do
      expect(midpoint('backgroundColor', 'rgba(0,128,0,0)', 'rgb(0,128,0)', easing: OVERSHOOT))
        .to eq('rgb(0, 160, 0)')
    end
  end

  describe 'serialization' do
    # Alpha lives in eight bits like every other channel, and reports as the SHORTEST decimal that
    # rounds back to its byte — 128 is `0.5`, 192 is `0.753`, and a shadow is no different.
    it 'reports the shortest alpha that rounds back to its byte' do
      expect(midpoint('backgroundColor', 'rgba(255,0,0,1)', 'rgba(0,0,255,0)')).to eq('rgba(255, 0, 0, 0.5)')
      expect(midpoint('boxShadow', 'rgba(255,0,0,1) 0px 0px', 'rgba(0,0,255,0.5) 10px 10px'))
        .to eq('rgba(170, 0, 85, 0.753) 5px 5px 0px 0px')
    end

    # Six SIGNIFICANT digits, which is what a browser reports for a third of a hundred pixels.
    it 'reports six significant digits' do
      s = page('<div id="a"></div>')
      value = s.evaluate_script(<<~JS)
        (function () {
          const el = document.getElementById('a');
          const anim = el.animate([{ marginLeft: '0px' }, { marginLeft: '100px' }],
                                  { duration: 3000, fill: 'both' });
          anim.pause();
          anim.currentTime = 1000;
          return getComputedStyle(el).marginLeft;
        })()
      JS
      expect(value).to eq('33.3333px')
    end

    # A length mixed with a percentage is the `calc()` a browser writes: the percentage first, a
    # negative length SUBTRACTED, and a length that has reached zero absorbed altogether.
    it 'writes a mixed length and percentage as calc()' do
      expect(midpoint('textIndent', '0px', '50%')).to eq('25%')
      expect(midpoint('textIndent', '10px', '50%')).to eq('calc(25% + 5px)')
      expect(midpoint('textIndent', '-10px', '50%')).to eq('calc(25% - 5px)')
    end
  end

  describe 'the computed value an endpoint is written in' do
    # Both ends of an interpolation go through the property's OWN computed-value serializer, so
    # they are comparable: a filter's angle in degrees and its proportions as plain numbers, a
    # shadow's colour first and resolved. Without that, mixing a `1turn` with a `0deg` took the
    # first unit it saw and reported half a degree.
    it 'normalizes a filter to its canonical units' do
      s = page('<div id="a" style="filter: hue-rotate(1turn) brightness(50%) drop-shadow(10px 10px red)"></div>')
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).filter"))
        .to eq('hue-rotate(360deg) brightness(0.5) drop-shadow(rgb(255, 0, 0) 10px 10px 0px)')
      expect(midpoint('filter', 'hue-rotate(0deg)', 'hue-rotate(1turn)')).to eq('hue-rotate(180deg)')
    end

    # An OMITTED filter argument is the function's default, which is not its identity: `grayscale()`
    # is fully grey, `blur()` no blur at all.
    it 'fills in an omitted filter argument' do
      s = page('<div id="a" style="filter: grayscale() blur() drop-shadow(1em 1em)"></div>')
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).filter"))
        .to eq('grayscale(1) blur(0px) drop-shadow(rgb(0, 255, 0) 16px 16px 0px)')
    end

    it 'resolves currentcolor in a computed shadow' do
      s = page('<div id="a" style="box-shadow: currentcolor 10px 10px"></div>')
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).boxShadow"))
        .to eq('rgb(0, 255, 0) 10px 10px 0px 0px')
    end

    # A `drop-shadow()` IS a shadow, and interpolates as one.
    it 'interpolates a drop-shadow' do
      expect(midpoint('filter', 'none', 'drop-shadow(rgb(100,100,100) 10px 10px 10px)'))
        .to eq('drop-shadow(rgba(100, 100, 100, 0.5) 5px 5px 5px)')
    end

    # A transform's PERCENTAGES resolve against the element's own border box, which is what makes
    # a `translateX(20px)` to `translateX(50%)` pair a real interpolation rather than a flip. The
    # box here is the 100px-wide one every test in this file uses, so half way is 35 — the same
    # rule Chrome shows at 60 on a 200px box.
    it 'resolves a translate percentage against the box' do
      expect(midpoint('transform', 'translateX(20px)', 'translateX(50%)')).to eq('matrix(1, 0, 0, 1, 35, 0)')
    end
  end

  describe 'more of the transform list' do
    # An OMITTED argument is what the function means without it: `scale(2)` is `scale(2, 2)`, where
    # `translate(10px)` is `translate(10px, 0)` — so a pair with different argument counts lines up.
    it 'fills in an omitted transform argument' do
      expect(midpoint('transform', 'scale(2)', 'scale(4, 6)')).to eq('matrix(3, 0, 0, 4, 0, 0)')
      expect(midpoint('transform', 'translate(10px)', 'translate(30px, 40px)'))
        .to eq('matrix(1, 0, 0, 1, 20, 20)')
    end

    # `none` is a keyword, not a string to compare.
    it 'reads none case-insensitively' do
      expect(midpoint('transform', 'NONE', 'translateX(100px)')).to eq('matrix(1, 0, 0, 1, 50, 0)')
    end

    # A `perspective()` interpolates its RECIPROCAL — half way from no perspective to 100px is 200,
    # not 50 (Chrome-measured, as the `-0.005` of the matrix it reports). Chrome reports the whole
    # value as a `matrix3d`; this engine does not model a 3D matrix and reports the function list,
    # which is a separate listed gap.
    it 'interpolates a perspective as its reciprocal' do
      expect(midpoint('transform', 'none', 'perspective(100px)')).to eq('perspective(200px)')
    end
  end

  describe 'more composite operations' do
    # Accumulation is `a + b` only where the identity is ZERO. Everywhere else the identity comes
    # off once, or two brightnesses accumulate to five where Chrome reports four.
    it 'subtracts the identity when it accumulates' do
      expect(midpoint('filter', 'brightness(3)', 'brightness(3)',
                      composite: 'accumulate', style: 'filter: brightness(2)')).to eq('brightness(4)')
      expect(midpoint('transform', 'scale(3)', 'scale(3)',
                      composite: 'accumulate', style: 'transform: scale(2)')).to eq('matrix(4, 0, 0, 4, 0, 0)')
    end

    # A SHADOW list accumulates componentwise as well — it is a list like any other — and a list
    # shorter than the other is padded rather than dropped.
    it 'accumulates a shadow list and pads a ragged one' do
      expect(midpoint('boxShadow', 'rgb(10,0,0) 3px 3px 3px 3px', 'rgb(10,0,0) 3px 3px 3px 3px',
                      composite: 'accumulate', style: 'box-shadow: rgb(20,0,0) 2px 2px 2px 2px'))
        .to eq('rgb(30, 0, 0) 5px 5px 5px 5px')
      expect(midpoint('filter', 'blur(3px) brightness(3)', 'blur(3px) brightness(3)',
                      composite: 'accumulate', style: 'filter: blur(2px)')).to eq('blur(5px) brightness(3)')
    end

    # Two colours whose alphas MATCH add channel by channel and keep that alpha; two whose alphas
    # differ add premultiplied and take the sum (Chrome-measured, both).
    it 'adds two colours by their alphas' do
      expect(midpoint('backgroundColor', 'rgba(40,50,60,0.5)', 'rgba(40,50,60,0.5)',
                      composite: 'add', style: 'background-color: rgba(10,20,30,0.5)'))
        .to eq('rgba(50, 70, 90, 0.5)')
      expect(midpoint('backgroundColor', 'rgba(255,0,0,0.3)', 'rgba(255,0,0,0.3)',
                      composite: 'add', style: 'background-color: rgba(0,0,255,0.2)'))
        .to eq('rgba(153, 0, 102, 0.5)')
    end

    # A LENGTH composes only where the property really is one value: `font-size` adds, and the
    # track list two lines below does not (both Chrome-measured).
    it 'adds a length where the property composes one' do
      expect(midpoint('fontSize', '20px', '20px', composite: 'add', style: 'font-size:10px')).to eq('30px')
    end
  end

  # `letter-spacing: normal` IS a zero spacing, where for most properties `normal` is a keyword
  # with nothing behind it.
  it 'interpolates letter-spacing from normal as from zero' do
    expect(midpoint('letterSpacing', 'normal', '10px')).to eq('5px')
  end

  # An `inset` shadow interpolates against an inset identity — padding `none` with an outset one
  # would be a pair that disagrees, and disagreeing is what makes a shadow list flip discretely.
  it 'pads none with the other side\'s inset' do
    expect(midpoint('boxShadow', 'none', 'rgb(100,100,100) 10px 10px 10px 10px inset'))
      .to eq('rgba(100, 100, 100, 0.5) 5px 5px 5px 5px inset')
  end
  # A composite operation belongs to the KEYFRAME, not to the effect: each keyframe composites with
  # the value underneath before anything is interpolated. Compositing the interpolated result
  # instead agrees only where the operation is linear, which is why an all-`add` effect never
  # showed it (Chrome-measured, every line).
  describe 'a composite per keyframe' do
    it 'composites each keyframe before interpolating' do
      expect(mixed('opacity', '0', 'add', '0.4', 'replace', 'opacity:0.5')).to eq('0.45')
      expect(mixed('opacity', '0', 'replace', '0.4', 'add', 'opacity:0.5')).to eq('0.45')
      expect(mixed('opacity', '0', 'add', '0.4', 'add', 'opacity:0.5')).to eq('0.7')
      expect(mixed('filter', 'blur(4px)', 'accumulate', 'blur(10px)', 'replace', 'filter:blur(2px)'))
        .to eq('blur(8px)')
    end

    # …and a list keyframe that ADDS is the underlying list with the keyframe's appended, which the
    # other end then pads against — two shadows against one.
    it 'interpolates against a list a keyframe added to' do
      expect(mixed('boxShadow', 'rgb(0,0,0) 0px 0px 0px 0px', 'add',
                   'rgb(100,100,100) 10px 10px 10px 10px', 'replace',
                   'box-shadow: rgb(10,0,0) 1px 1px 1px 1px'))
        .to eq('rgb(55, 50, 50) 5.5px 5.5px 5.5px 5.5px, rgba(0, 0, 0, 0.5) 0px 0px 0px 0px')
    end
  end
  # `animation-composition` says how a CSS animation's keyframes combine with the value underneath
  # them, the same operations `element.animate` takes — per animation, or per keyframe. (A NEGATIVE
  # delay is how these seek: a `CSSAnimation`'s `currentTime` does not drive the animation it
  # mirrors yet, which is the gap that keeps `css/css-animations/animation-composition.html`
  # listed.)
  describe 'animation-composition' do
    def composed(css, prop, delay)
      s = page(%(<div id="a" style="animation-delay: #{delay}"></div>), css)
      s.evaluate_script("getComputedStyle(document.getElementById('a')).#{prop}")
    end

    it 'composites a CSS animation onto the underlying value' do
      css = <<~CSS
        @keyframes grow { from { filter: blur(10px) } to { filter: blur(20px) } }
        div { filter: blur(5px); animation: grow 1s linear both; animation-composition: add }
      CSS
      expect(composed(css, 'filter', '0s')).to eq('blur(5px) blur(10px)')
      expect(composed(css, 'filter', '-500ms')).to eq('blur(5px) blur(15px)')
    end

    # `accumulate` is the other operation, and for a filter it is not the same answer as `add`.
    it 'accumulates a CSS animation onto the underlying value' do
      css = <<~CSS
        @keyframes grow { from { filter: blur(10px) } to { filter: blur(20px) } }
        div { filter: blur(5px); animation: grow 1s linear both; animation-composition: accumulate }
      CSS
      expect(composed(css, 'filter', '-500ms')).to eq('blur(20px)')
    end

    # …and a keyframe may name its own, which governs that keyframe alone.
    it 'takes the operation a keyframe names for itself' do
      css = <<~CSS
        @keyframes grow { from { animation-composition: add; opacity: 0 } to { opacity: 0.4 } }
        div { opacity: 0.5; animation: grow 1s linear both }
      CSS
      expect(composed(css, 'opacity', '-500ms')).to eq('0.45')
    end
  end

  # A length ADDED to a percentage has no common unit, and composes into the `calc()` holding both
  # — which the next combination reads back, and which the computed surface reports in ONE order
  # whether an animation produced it or the author wrote it.
  describe 'a length and a percentage together' do
    it 'composes them into one calc()' do
      expect(midpoint('flexBasis', '100px', '20%', composite: 'add', style: 'flex-basis:10%'))
        .to eq('calc(20% + 50px)')
      expect(midpoint('verticalAlign', '10%', '110%', style: 'vertical-align:10%')).to eq('60%')
    end

    it 'reports a mixed calc() percentage-first however it was written' do
      s = page('<div id="a" style="flex-basis: calc(130px + 4%)"></div>')
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).flexBasis"))
        .to eq('calc(4% + 130px)')
    end
  end
  # The classes a second adversarial review found unpinned — each is a Chrome measurement, and each
  # is a rule this file's other examples pass whichever way it goes.
  describe 'the edges of the model' do
    # A SYNTHESISED end — the one a single-keyframe effect gets for free — IS the underlying value,
    # and composites with nothing. Only the keyframes the page wrote do.
    it 'does not composite a neutral end' do
      s = page('<div id="a" style="opacity:0.5"></div>')
      expect(s.evaluate_script(<<~JS)).to eq(%w[0.5 0.7])
        (function () {
          const el = document.getElementById('a');
          const anim = el.animate([{ opacity: '0.2', offset: 1, composite: 'add' }],
                                  { duration: 1000, fill: 'both' });
          anim.pause();
          const out = [];
          for (const t of [0, 1000]) { anim.currentTime = t; out.push(getComputedStyle(el).opacity); }
          return out;
        })()
      JS
    end

    # A shadow endpoint that resolved `currentcolor` is only good while that colour is — and the
    # colour may be the PARENT's, which no style epoch here moves.
    it 'follows a colour the parent changes mid-animation' do
      s = page('<div id="p"><div id="a"></div></div>')
      expect(s.evaluate_script(<<~JS)).to eq(['rgb(0, 255, 0) 5px 5px 5px 5px', 'rgb(0, 0, 255) 5px 5px 5px 5px'])
        (function () {
          const el = document.getElementById('a');
          const anim = el.animate([{ boxShadow: 'currentcolor 0px 0px 0px 0px' },
                                   { boxShadow: 'currentcolor 10px 10px 10px 10px' }],
                                  { duration: 1000, fill: 'both' });
          anim.pause();
          anim.currentTime = 500;
          const before = getComputedStyle(el).boxShadow;
          document.getElementById('p').style.color = 'rgb(0, 0, 255)';
          return [before, getComputedStyle(el).boxShadow];
        })()
      JS
    end

    # An `animation-composition` list is valid WHOLE or not at all: one unknown keyword drops the
    # declaration, where repairing it item by item let a typo change a rendered number.
    it 'drops an animation-composition list with an unknown keyword' do
      s = page('<div id="a"></div>', <<~CSS)
        @keyframes k { from { opacity: 0 } to { opacity: 0.4 } }
        div { opacity: 0.5; animation: k 1s linear both; animation-delay: -500ms;
              animation-composition: add, bogus }
      CSS
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity")).to eq('0.2')
    end

    # A CUSTOM property's computed value is its specified token stream: the canonical order a
    # length-percentage mixture takes is for the properties that HAVE a type.
    it 'never reorders a custom property' do
      s = page('<div id="a" style="--z: calc(5px + 10%)"></div>')
      expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).getPropertyValue('--z')"))
        .to eq('calc(5px + 10%)')
    end

    # A filter amount is CAPPED where the function is a proportion, uncapped where it is a gain,
    # and NEGATIVE nowhere — a negative one is an invalid declaration, and the property reports its
    # initial. `inset` is a `box-shadow` word: a `text-shadow` or a `drop-shadow()` with one is
    # invalid too, rather than a shadow with an extra flag.
    it 'validates a filter and a shadow the way their grammars do' do
      s = page(<<~HTML)
        <div id="a" style="filter: grayscale(150%)"></div>
        <div id="b" style="filter: brightness(150%)"></div>
        <div id="c" style="filter: saturate(-10%)"></div>
        <div id="d" style="filter: drop-shadow(1px 1px 1px inset)"></div>
        <div id="e" style="text-shadow: rgb(0,0,0) 1px 1px 1px inset"></div>
        <div id="f" style="text-shadow: rgb(0,0,0) 1px 1px 1px 1px"></div>
        <div id="g" style="filter: url(#f)"></div>
      HTML
      expect(s.evaluate_script(<<~JS)).to eq(['grayscale(1)', 'brightness(1.5)', 'none', 'none', 'none', 'none', 'url("#f")'])
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => {
          const el = document.getElementById(id);
          return getComputedStyle(el)[id === 'e' || id === 'f' ? 'textShadow' : 'filter'];
        })
      JS
    end

    # A transform list accumulates by concatenation where its functions do not line up — unless it
    # holds a SINGULAR matrix, which there is no accumulating onto: the effect's value stands
    # alone. (A `matrix3d` is reported as the page wrote it: this engine composes the 2D matrices
    # only, which is the 3D serialization gap the module header lists.)
    it 'refuses to accumulate onto a singular matrix' do
      singular3d = 'matrix3d(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)'
      expect(midpoint('transform', singular3d, singular3d,
                      composite: 'accumulate', style: 'transform: translateX(10px)')).to eq(singular3d)
      expect(midpoint('transform', 'matrix(1, 1, 0, 0, 0, 100)', 'matrix(1, 1, 0, 0, 0, 100)',
                      composite: 'accumulate', style: 'transform: translateX(10px)'))
        .to eq('matrix(1, 1, 0, 0, 0, 100)')
      # …where an INVERTIBLE one concatenates onto what is underneath.
      expect(midpoint('transform', 'matrix(2, 0, 0, 2, 0, 0)', 'matrix(2, 0, 0, 2, 0, 0)',
                      composite: 'accumulate', style: 'transform: translateX(10px)'))
        .to eq('matrix(2, 0, 0, 2, 10, 0)')
    end
  end
  # A keyframe may name a SHORTHAND, and each longhand under it takes ITS OWN component of the
  # value — through the cascade's own expander, the same one a declaration goes through. Handing
  # every longhand the whole text only looked right for the box shorthands, where they all take the
  # same token.
  describe 'a keyframe that names a shorthand' do
    def longhands(prop, from, to, read)
      s = page('<div id="a">x</div>')
      s.evaluate_script(<<~JS)
        (function () {
          const el = document.getElementById('a');
          const anim = el.animate([{ #{prop.inspect}: #{from.inspect} }, { #{prop.inspect}: #{to.inspect} }],
                                  { duration: 1000, fill: 'both' });
          anim.pause();
          anim.currentTime = 500;
          return #{read.inspect}.map((p) => getComputedStyle(el).getPropertyValue(p));
        })()
      JS
    end

    it 'gives each longhand its own component' do
      expect(longhands('columns', '10px 3', '30px 3', %w[column-width column-count])).to eq(['20px', '3'])
      expect(longhands('flexFlow', 'row wrap', 'column wrap', %w[flex-direction flex-wrap]))
        .to eq(%w[column wrap])
      expect(longhands('margin', '0px', '20px', %w[margin-left margin-top])).to eq(['10px', '10px'])
    end

    # …including the four the CSSOM registry does not carry at all — they live only in the
    # cascade's hand-written expanders, which is exactly why the registry must not be asked first.
    it 'expands the shorthands the registry does not carry' do
      expect(longhands('background', 'rgb(0,0,0)', 'rgb(100,100,100)', %w[background-color]))
        .to eq(['rgb(50, 50, 50)'])
      expect(longhands('inset', '0px', '20px', %w[top left])).to eq(['10px', '10px'])
      expect(longhands('font', 'italic bold 10px/20px serif', 'italic bold 30px/60px serif',
                       %w[font-size font-weight])).to eq(['20px', '700'])
      expect(longhands('textDecoration', 'underline rgb(0,0,0)', 'underline rgb(100,100,100)',
                       %w[text-decoration-color])).to eq(['rgb(50, 50, 50)'])
    end
  end

  # mdn's animation data is a record, not the spec: it calls eight properties NOT ANIMATABLE that a
  # browser animates, and two DISCRETE that are a colour and a number. Each was measured in Chrome.
  describe 'properties mdn types wrongly' do
    def sample(prop, from, to, at, id = 'a', markup = '<div id="a">x</div>')
      s = page(markup)
      s.evaluate_script(<<~JS)
        (function () {
          const el = document.getElementById(#{id.inspect});
          const anim = el.animate([{ #{prop.inspect}: #{from.inspect} }, { #{prop.inspect}: #{to.inspect} }],
                                  { duration: 1000, fill: 'both' });
          anim.pause();
          anim.currentTime = #{at};
          return getComputedStyle(el).getPropertyValue(#{cssName(prop).inspect});
        })()
      JS
    end

    it 'animates the ones mdn calls not animatable' do
      expect(sample('backgroundBlendMode', 'multiply', 'screen', 400)).to eq('multiply')
      expect(sample('backgroundBlendMode', 'multiply', 'screen', 600)).to eq('screen')
      expect(sample('touchAction', 'auto', 'none', 600)).to eq('none')
      expect(sample('isolation', 'auto', 'isolate', 400)).to eq('auto')
      # …and `math-depth` counts rather than flipping.
      expect(sample('mathDepth', '1', '3', 400)).to eq('2')
    end

    # mdn records `stroke` as an ARRAY of property names rather than a type, so it had none at all
    # and its keyframes were dropped — a fixes table that can only CORRECT an existing entry would
    # have gone on doing nothing for it.
    it 'animates an SVG paint' do
      expect(sample('stroke', 'rgb(0,0,0)', 'rgb(100,100,100)', 500, 'r',
                    '<svg style="width:10px;height:10px"><rect id="r"/></svg>')).to eq('rgb(50, 50, 50)')
    end

    # …and an opacity CLAMPS at both ends, which only an extrapolating easing reaches — mdn gives
    # these three no range, and unlike `opacity` they have no computed-value reader to clamp them.
    it 'clamps an opacity that overshoots' do
      s = page('<svg style="width:10px;height:10px"><stop id="s"/></svg>')
      expect(s.evaluate_script(<<~JS)).to eq(%w[0 1])
        (function () {
          const el = document.getElementById('s');
          const anim = el.animate([{ stopOpacity: '0' }, { stopOpacity: '1' }],
                                  { duration: 1000, fill: 'both', easing: 'cubic-bezier(0.5, -1, 0.5, 2)' });
          anim.pause();
          const out = [];
          for (const t of [200, 800]) { anim.currentTime = t; out.push(getComputedStyle(el).stopOpacity); }
          return out;
        })()
      JS
    end

    it 'fades an SVG gradient stop' do
      svg = '<svg width="10" height="10"><stop id="s"/></svg>'
      expect(sample('stopColor', 'rgb(0,0,0)', 'rgb(100,100,100)', 500, 's', svg)).to eq('rgb(50, 50, 50)')
      expect(sample('stopOpacity', '0', '1', 500, 's', svg)).to eq('0.5')
    end
  end

  # A colour endpoint is normalised for EVERY colour-valued property, not only the ones mdn types
  # literally as `color` — `color` itself is "by computed value type" — or a `#RGB` / `hsl()` pair
  # is one the interpolator cannot read, and flips where a browser fades.
  it 'interpolates a colour written any way' do
    expect(midpoint('color', '#000', '#0f0')).to eq('rgb(0, 128, 0)')
    expect(midpoint('color', 'hsl(0, 100%, 50%)', 'hsl(120, 100%, 50%)')).to eq('rgb(128, 128, 0)')
    expect(midpoint('caretColor', '#000', '#0f0')).to eq('rgb(0, 128, 0)')
  end
end
