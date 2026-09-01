# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The interpolation types the value model did not have. A property whose type has no handler falls
# through to DISCRETE, which for a transition means it never starts at all — no `transitionend`, and
# the value at the first frame is already the target. Five properties' worth of the css-transitions
# `properties-value` files were exactly that.
#
# Every figure is Chrome 151-measured on this machine: the transition is given a negative delay of
# half its duration, so the value read straight after it starts is its half-way point.
RSpec.describe 'transition value types' do
  # Three background layers, so a layered longhand reports and animates three entries.
  THREE_LAYERS = 'background-image:linear-gradient(red,red),linear-gradient(blue,blue),' \
                 'linear-gradient(teal,teal);'

  # The computed value of `prop` on an element that declares it and nothing else.
  def computed(prop, value, extra = '')
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var d = document.createElement('div');
        d.style.cssText = 'width:100px;height:20px;#{extra}' + #{prop.to_json} + ':' + #{value.to_json};
        document.body.appendChild(d);
        return getComputedStyle(d).getPropertyValue(#{prop.to_json});
      })()
    JS
  end

  # The computed value of `prop` half way through a 10s transition from `from` to `to`.
  def midpoint(prop, from, to, extra = '')
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var d = document.createElement('div');
        d.style.cssText = 'width:100px;height:20px;#{extra}' + #{prop.to_json} + ':' + #{from.to_json};
        document.body.appendChild(d);
        getComputedStyle(d)[#{prop.to_json}];
        d.style.transition = #{prop.to_json} + ' 10s linear -5s';
        d.style.setProperty(#{prop.to_json}, #{to.to_json});
        return getComputedStyle(d).getPropertyValue(#{prop.to_json});
      })()
    JS
  end

  # `line-height` is two types at once — a bare number or a length — and the computed value is a
  # length either way, so it is the length arm that runs.
  it 'interpolates line-height' do
    expect(midpoint('line-height', '1.5', '3')).to     eq('36px')
    expect(midpoint('line-height', '20px', '40px')).to eq('30px')
  end

  # A REPEATABLE LIST interpolates entry by entry, its two sides repeated to a common length.
  it 'interpolates a repeatable list' do
    expect(midpoint('background-position-x', '10px', '50px')).to eq('30px')
  end

  # A `<line-width>` keyword is a length once computed, so an endpoint written as one interpolates.
  it 'interpolates between line-width keywords' do
    expect(midpoint('outline-width', 'thin', 'thick', 'outline-style:solid;')).to eq('3px')
    expect(midpoint('outline-width', '2px', '10px', 'outline-style:solid;')).to eq('6px')
  end

  # …and in units other than px, which the resolved-value read used to give up on and report the
  # initial `medium` for — so both ends of a `10pt` to `20pt` transition were 3px and it never ran.
  # A line width is USED at whole-px granularity: Chrome floors it, never below 1px for a width the
  # author asked for, and the floored figure is what the box measures.
  it 'computes a line width in any unit' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq(['13px', '160px', '5px', '1px', '2px'])
      ['10pt', '10pc', 'thick', '0.4px', '2.5px'].map(function (w) {
        var d = document.createElement('div');
        d.style.cssText = 'outline-style:solid;outline-width:' + w;
        document.body.appendChild(d);
        var v = getComputedStyle(d).outlineWidth;
        d.remove();
        return v;
      })
    JS
  end

  # A property that accepts a PERCENTAGE interpolates between two of them, whatever mdn calls its
  # animation type: the length handler refuses a percentage pair, so `margin-left` used to flip.
  # (The px it reports is a share of the body's width, which the viewport decides — what matters is
  # that it resolved at all.)
  it 'interpolates percentage margins' do
    expect(midpoint('margin-left', '10%', '50%')).to match(/\A[\d.]+px\z/)
  end

  # A NUMBER and a LENGTH are two types at once for `tab-size` as well, and the pair that mixes them
  # has no common ground: it flips discretely, where reading both ends as lengths interpolated them.
  it 'keeps a number and a length apart' do
    expect(midpoint('tab-size', '4', '8px')).to eq('8px')
    expect(midpoint('tab-size', '2', '8')).to   eq('5')
  end

  # `stroke-dasharray` is the list whose entries are separated by WHITESPACE as well as commas, and
  # whose bare numbers are lengths — SVG user units are px.
  it 'interpolates a whitespace-separated list' do
    expect(midpoint('stroke-dasharray', '4 2', '10 5')).to     eq('7px, 3.5px')
    expect(midpoint('stroke-dasharray', '1px 2px', '5px')).to  eq('3px, 3.5px')
    expect(computed('stroke-dasharray', '4 2')).to             eq('4px, 2px')
    expect(computed('stroke-dasharray', 'none')).to            eq('none')
  end

  # Two lists of different lengths are both repeated to the LEAST COMMON MULTIPLE of their
  # lengths before they interpolate, so a 2-entry list against a 3-entry one has six entries.
  it 'repeats two lists to their common multiple' do
    expect(midpoint('stroke-dasharray', '10px 20px', '30px 40px 50px'))
      .to eq('20px, 30px, 30px, 25px, 25px, 35px')
  end

  # A background list is reported — and animated — per LAYER: the count comes from the element's
  # `background-image`, so a three-entry value on an element with no image keeps its first entry
  # alone, and a one-entry value on a three-image element is repeated to three.
  it 'repeats a background list to its layer count' do
    expect(midpoint('background-position-x', '0px, 10px, 20px', '30px, 60px')).to eq('15px')
    expect(computed('background-position-x', '0px, 10px, 20px')).to             eq('0px')
    expect(computed('background-position-x', '10px', THREE_LAYERS)).to          eq('10px, 10px, 10px')
    expect(midpoint('background-position-x', '10px', '40px', THREE_LAYERS)).to  eq('25px, 25px, 25px')
  end

  # A `<position>` keyword is an OFFSET once computed, and only the offsets interpolate.
  it 'interpolates position keywords' do
    expect(midpoint('background-position-x', 'left', 'right')).to           eq('50%')
    expect(midpoint('background-position-x', 'left 10px', 'right 20px')).to eq('calc(50% - 5px)')
    expect(midpoint('object-position', 'left top', 'right bottom')).to      eq('50% 50%')
    expect(computed('background-position-x', 'right 10px')).to             eq('calc(100% - 10px)')
    expect(computed('object-position', 'left top')).to                     eq('0% 0%')
  end

  # A value that is a run of tokens interpolates token by token, whether or not it is also a list.
  it 'interpolates a token run' do
    expect(midpoint('background-size', '10px 20px', '30px 40px')).to eq('20px 30px')
    expect(midpoint('border-spacing', '2px', '10px')).to             eq('6px')
  end

  # An endpoint outside the property's range is not a value it takes: the declaration is dropped
  # whole, and what runs is a transition from the value underneath it — which for a `line-height`
  # that has none is `normal`, so the target shows for the entire transition.
  it 'drops an out-of-range endpoint' do
    expect(midpoint('line-height', '-1', '2')).to eq('32px')
  end
end
