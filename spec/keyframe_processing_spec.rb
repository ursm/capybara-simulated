# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What `element.animate()` and `new KeyframeEffect(…)` ACCEPT, and what they report back. Web
# Animations rejects what CSS merely ignores: an easing a stylesheet would drop is a TypeError
# here, and a member that is no animatable property is never even read.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'processing a keyframes argument' do
  def page
    html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="a">x</div></body></html>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # Each expression is evaluated with `el` in scope; the result is JSON, or `THROW <name>`.
  def results(*expressions)
    page.evaluate_script(<<~JS)
      (function () {
        const el = document.getElementById('a');
        const t = (fn) => { try { return JSON.stringify(fn()); } catch (e) { return 'THROW ' + e.name; } };
        return [#{expressions.map { |e| "t(() => #{e})" }.join(', ')}];
      })()
    JS
  end

  describe 'the easing' do
    # A keyword is canonical and case-insensitive, and the two step keywords report as the `steps()`
    # they stand for — with the default position omitted.
    it 'reports the canonical form' do
      expect(results(
        "new KeyframeEffect(el, null, {easing: 'EASE-IN'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'step-start'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'step-end'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'cubic-bezier(0,0,1,1)'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'steps(2,jump-none)'}).getTiming().easing"
      )).to eq(['"ease-in"', '"steps(1, start)"', '"steps(1)"', '"cubic-bezier(0, 0, 1, 1)"',
                '"steps(2, jump-none)"'])
    end

    # …and it is CSS syntax carried in a string, so an identifier may be escaped: `\2d` is the `-`,
    # and the space after it is the escape's terminator rather than a token of its own.
    it 'reads an escaped identifier' do
      expect(results("new KeyframeEffect(el, null, {easing: 'Ease\\\\2d in-out'}).getTiming().easing"))
        .to eq(['"ease-in-out"'])
    end

    # `linear()` (css-easing-2) is a list of stops, and its canonical form fills in every position:
    # the first is 0%, the last 100%, a gap is spaced evenly, a stop written with two positions is
    # two stops, and a position never goes backwards.
    it 'canonicalizes a linear() easing, and runs it' do
      expect(results(
        "new KeyframeEffect(el, null, {easing: 'linear(0, 1, 0)'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'linear(0 0% 50%, 1)'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'linear(1 100%, 0 0%)'}).getTiming().easing",
        "new KeyframeEffect(el, null, {easing: 'linear(0)'})"
      )).to eq(['"linear(0 0%, 1 50%, 0 100%)"', '"linear(0 0%, 0 50%, 1 100%)"',
                '"linear(1 100%, 0 100%)"', 'THROW TypeError'])
    end

    it 'samples a linear() easing piecewise' do
      expect(page.evaluate_script(<<~JS)).to eq(%w[0 0.5 1 0.5 0])
        (function () {
          const el = document.getElementById('a');
          const anim = el.animate([{ opacity: '0' }, { opacity: '1' }],
                                  { duration: 1000, fill: 'both', easing: 'linear(0, 1, 0)' });
          anim.pause();
          return [0, 250, 500, 750, 1000].map((t) => { anim.currentTime = t; return getComputedStyle(el).opacity; });
        })()
      JS
    end

    # Everything a browser cannot parse is a TypeError — including the empty string, a CSS-wide
    # keyword, a bezier whose X is outside [0,1], a fractional or non-positive step count, and
    # `jump-none` with too few steps to jump between.
    it 'throws on anything it cannot parse' do
      expect(results(
        "new KeyframeEffect(el, null, {easing: ''})",
        "new KeyframeEffect(el, null, {easing: 'bogus'})",
        "new KeyframeEffect(el, null, {easing: 'inherit'})",
        "new KeyframeEffect(el, null, {easing: 'ease-in-out extra'})",
        "new KeyframeEffect(el, null, {easing: 'cubic-bezier(0,0,2,1)'})",
        "new KeyframeEffect(el, null, {easing: 'steps(2.5)'})",
        "new KeyframeEffect(el, null, {easing: 'steps(0)'})",
        "new KeyframeEffect(el, null, {easing: 'steps(1,jump-none)'})"
      )).to eq(['THROW TypeError'] * 8)
    end
  end

  describe 'the offsets' do
    # An offset is CSS syntax too: a `calc()` is one, and a plain string converts as a number would.
    it 'takes a calc() and a numeric string' do
      expect(results(
        "new KeyframeEffect(el, [{left: '0px', offset: 'calc(0.5)'}, {left: '1px'}]).getKeyframes()[0].offset",
        "new KeyframeEffect(el, [{left: '0px', offset: '0.5'}, {left: '1px'}]).getKeyframes()[0].offset",
        "new KeyframeEffect(el, {left: ['0px', '1px'], offset: 'calc(0.5)'}).getKeyframes()[0].offset"
      )).to eq(%w[0.5 0.5 0.5])
    end

    # A NULL in a property-indexed offset list means "space this one evenly", not zero.
    it 'spaces a null offset evenly' do
      expect(results(
        "new KeyframeEffect(el, {left: ['0px','1px','2px'], offset: [0, null, 1]}).getKeyframes().map((k) => k.computedOffset)"
      )).to eq(['[0,0.5,1]'])
    end

    # …and they must be loosely sorted, in either form.
    it 'throws on an offset that goes backwards' do
      expect(results(
        "new KeyframeEffect(el, [{left: '0px', offset: 0.6}, {left: '1px', offset: 0.2}])",
        "new KeyframeEffect(el, {left: ['0px','1px'], offset: [0.6, 0.2]})",
        "new KeyframeEffect(el, [{left: '0px', offset: 'abc'}, {left: '1px'}])",
        "new KeyframeEffect(el, [{left: '0px', offset: 2}, {left: '1px'}])"
      )).to eq(['THROW TypeError'] * 4)
    end
  end

  describe 'the composite' do
    # `auto` is a KEYFRAME's answer — "take the effect's" — and the effect itself has no such value.
    it 'throws on an operation neither the keyframe nor the effect has' do
      expect(results(
        "new KeyframeEffect(el, [{left: '0px', composite: 'bogus'}, {left: '1px'}])",
        "new KeyframeEffect(el, {left: ['0px','1px'], composite: 'bogus'})",
        "new KeyframeEffect(el, {left: ['0px','1px']}, {composite: 'bogus'})",
        "new KeyframeEffect(el, {left: ['0px','1px']}, {composite: 'auto'})"
      )).to eq(['THROW TypeError'] * 4)
    end
  end

  describe 'the members' do
    # A member that is no CSS property at all is IGNORED, not carried through as one — which is what
    # feeding `getKeyframes()` back into the constructor does with `computedOffset`.
    it 'drops a member that is no property, and keeps a custom one' do
      expect(results(
        "Object.keys(new KeyframeEffect(el, [{bogusProp: '1', left: '0px'}, {left: '10px'}]).getKeyframes()[0])",
        "Object.keys(new KeyframeEffect(el, new KeyframeEffect(el, [{left: '0px'}, {left: '1px'}]).getKeyframes()).getKeyframes()[0])",
        "new KeyframeEffect(el, [{'--x': '1', left: '0px'}, {left: '10px'}]).getKeyframes()[0]['--x']"
      )).to eq(['["offset","easing","composite","left","computedOffset"]',
                '["offset","easing","composite","left","computedOffset"]',
                '"1"'])
    end

    # …and a member that is a property but NOT ANIMATABLE is never even read: the decision is made
    # from the name, before the value is touched. (A page can see the difference — the tests hold
    # implementations to it with getters that count their own accesses.)
    it 'never reads a non-animatable member' do
      expect(page.evaluate_script(<<~JS)).to eq([0, 'rgb(0, 0, 0)'])
        (function () {
          const el = document.getElementById('a');
          let reads = 0;
          const keyframe = { color: 'rgb(0, 0, 0)', get animationDelay() { reads++; return '1s'; } };
          const effect = new KeyframeEffect(el, [keyframe, { color: 'rgb(100, 100, 100)' }]);
          return [reads, effect.getKeyframes()[0].color];
        })()
      JS
    end
  end

  # Each interface carries its own class string, which is how a page tells an `Animation` from a
  # plain object.
  it 'reports its own class string' do
    expect(results(
      "Object.prototype.toString.call(el.animate(null, 1000))",
      "Object.prototype.toString.call(el.animate(null, 1000).effect)",
      "Object.prototype.toString.call(document.timeline)"
    )).to eq(['"[object Animation]"', '"[object KeyframeEffect]"', '"[object DocumentTimeline]"'])
  end
end
