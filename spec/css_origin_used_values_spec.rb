# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `transform-origin` and `perspective-origin` report the offsets they RESOLVE to, not the keywords
# the author wrote: `center` on a 100×20 box is `50px 10px`. Reporting the keyword left the pair
# uninterpolable — the list handler was in place and never got values it could mix — and gave page
# code a string it could not do arithmetic on.
#
# Chrome 151-measured on this machine, 32 cases; these are the rules behind them.
RSpec.describe 'origin used values' do
  def computed(value, css = '', prop = 'transform-origin')
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var d = document.createElement('div');
        d.style.cssText = 'width:100px;height:20px;font-size:10px;#{css}';
        d.style.setProperty(#{prop.to_json}, #{value.to_json});
        document.body.appendChild(d);
        return getComputedStyle(d).getPropertyValue(#{prop.to_json});
      })()
    JS
  end

  # The offsets a keyword or a percentage lands on, against the element's own box.
  it 'resolves keywords and percentages to px' do
    expect(computed('left top')).to     eq('0px 0px')
    expect(computed('center')).to       eq('50px 10px')
    expect(computed('right bottom')).to eq('100px 20px')
    expect(computed('10% 20%')).to      eq('10px 4px')
    expect(computed('1em')).to          eq('10px 10px')
    expect(computed('left top', '', 'perspective-origin')).to eq('0px 0px')
  end

  # …the BORDER box, padding and border included.
  it 'resolves against the border box' do
    expect(computed('50% 50%', 'padding:10px;border:5px solid;')).to eq('65px 25px')
    expect(computed('50% 50%', 'padding:10px;border:5px solid;box-sizing:border-box;')).to eq('50px 15px')
  end

  # With no box there is nothing to resolve against, and what shows is the computed value itself —
  # keywords and all turned into offsets.
  it 'reports the offsets themselves without a box' do
    expect(computed('center', 'display:none;')).to  eq('50% 50%')
    expect(computed('50% 50%', 'display:none;')).to eq('50% 50%')
  end

  # An origin's grammar gives each axis ONE component: no edge keyword binds a following offset,
  # which is what `background-position` does with the same text.
  it 'gives each axis one component' do
    expect(computed('left 10px')).to eq('0px 10px')
    # …and a fourth component is not a value this property takes, so the initial shows instead.
    expect(computed('right 10px bottom 20px')).to eq('50px 10px')
  end

  # A zero z is not reported; a non-zero one is.
  it 'reports the z axis only when it is not zero' do
    expect(computed('center center 0')).to eq('50px 10px')
    expect(computed('0 0 10px')).to        eq('0px 0px 10px')
  end

  # What INHERITS is the computed value — the offsets — so the child resolves the parent's
  # percentages against its OWN box rather than copying the parent's px.
  it 'inherits the offsets, not the pixels' do
    expect(computed('inherit')).to eq('50px 10px')
    expect(computed('initial')).to eq('50px 10px')
  end
end
