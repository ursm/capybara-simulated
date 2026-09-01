# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What `el.style` reports back. The SPECIFIED surface serializes the declaration's tokens — it does
# not echo the author's text — and this driver used to echo: `padding-left: 0` read back as `0`
# where every browser says `0px`, `#fff` stayed `#fff`, `rgb(1,2,3)` kept its missing spaces.
# Measured over 312 (property, value) pairs against Chrome 151, the divergence was 124; the rules
# below are what closed 111 of them.
#
# The COMPUTED surface has its own serialization (spec/computed_style_spec.rb); these are the
# specified one, read straight back off `el.style`.
RSpec.describe 'specified value serialization' do
  # `el.style[prop] = value`, read back.
  def specified(prop, value)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var d = document.createElement('div');
        document.body.appendChild(d);
        d.style.setProperty(#{prop.to_json}, #{value.to_json});
        return d.style.getPropertyValue(#{prop.to_json});
      })()
    JS
  end

  # A NUMBER is reported from its value, not from the way it was typed.
  it 'normalizes a number' do
    expect(specified('width', '5e1px')).to      eq('50px')
    expect(specified('width', '1e-2px')).to     eq('0.01px')
    expect(specified('flex-grow', '5e1')).to    eq('50')
    expect(specified('margin-left', '.5px')).to eq('0.5px')
    expect(specified('margin-left', '+5px')).to eq('5px')
  end

  # A bare `0` is a LENGTH for a length-valued property and reports its unit — and stays bare for a
  # number-valued one. Which of the two a property is was measured over all 471 longhands.
  it 'gives a length-valued zero its unit' do
    expect(specified('padding-left', '0')).to eq('0px')
    expect(specified('width', '0.0')).to      eq('0px')
    expect(specified('top', '-0')).to         eq('0px')
    expect(specified('opacity', '0')).to      eq('0')
    expect(specified('flex-grow', '0')).to    eq('0')
    # …but not inside a function, where the SLOT decides the type: `repeat()` counts, `scale()`
    # scales, and this driver does not type function slots yet.
    expect(specified('grid-template-columns', 'repeat(0, 100px)')).to eq('repeat(0, 100px)')
  end

  # A hex colour and the two legacy colour functions fold into the canonical form, here as well as
  # on the computed surface. An ALPHA reports the shortest decimal that rounds back to its byte.
  it 'canonicalizes a colour' do
    expect(specified('color', '#fff')).to               eq('rgb(255, 255, 255)')
    expect(specified('color', '#ffffff80')).to          eq('rgba(255, 255, 255, 0.5)')
    expect(specified('color', '#ffffffc0')).to          eq('rgba(255, 255, 255, 0.753)')
    expect(specified('color', 'hsl(120,50%,50%)')).to   eq('rgb(64, 191, 64)')
    expect(specified('color', 'rgb(1,2,3,0.5)')).to     eq('rgba(1, 2, 3, 0.5)')
    expect(specified('color', 'Rgb(1, 2, 3)')).to       eq('rgb(1, 2, 3)')
  end

  # An identifier that is one of the property's KEYWORDS folds; one that is not keeps its case.
  it 'folds a keyword and only a keyword' do
    expect(specified('color', 'RED')).to                    eq('red')
    expect(specified('animation-name', 'Fade')).to          eq('Fade')
    expect(specified('will-change', 'Transform')).to        eq('Transform')
    # …and in a grammar that also admits an arbitrary identifier, only when the keyword IS the whole
    # entry: the `Serif` of a family NAME is not the generic family.
    # (A multi-word family is also QUOTED on this surface, which is what Chrome reports — the point
    # here is the case of the words inside it.)
    expect(specified('font-family', 'PT Serif')).to          eq('"PT Serif"')
    expect(specified('font-family', 'Apple Color Emoji')).to eq('"Apple Color Emoji"')
  end

  # A value's own whitespace is not reported back — the token sequence is.
  it 'normalizes the spacing between tokens' do
    expect(specified('transform', 'translate(1px,2px)')).to      eq('translate(1px, 2px)')
    expect(specified('transform', 'translateX( 10px )')).to      eq('translateX(10px)')
    expect(specified('background-image', 'linear-gradient(red,blue)')).to eq('linear-gradient(red, blue)')
    expect(specified('aspect-ratio', '1/2')).to                  eq('1 / 2')
    expect(specified('font', '12px/1.5 Arial')).to                eq('12px / 1.5 Arial')
  end

  # …except where the value is still waiting on a SUBSTITUTION, which is not a value yet: Chrome
  # canonicalizes `counter( x )` and hands `var( --x , 1px )` back untouched.
  it 'leaves a substitution exactly as written' do
    expect(specified('width', 'var( --x , 1px )')).to  eq('var( --x , 1px )')
    expect(specified('width', 'env( safe-area-inset-top )')).to eq('env( safe-area-inset-top )')
    expect(specified('content', 'counter( x )')).to    eq('counter(x)')
  end

  # A few properties have a canonical SHAPE beyond their tokens.
  it 'reports the shape a property serializes in' do
    expect(specified('stroke-dasharray', '4 2')).to        eq('4, 2')
    expect(specified('border-spacing', '2px 2px')).to      eq('2px')
    expect(specified('aspect-ratio', '1')).to              eq('1 / 1')
    # …and a `<position>` always names both axes, the missing half being the axis the given one
    # does NOT name.
    expect(specified('background-position', 'center')).to  eq('center center')
    expect(specified('background-position', 'top')).to     eq('center top')
    expect(specified('transform-origin', '0')).to          eq('0px center')
  end

  # An operator inside a math function needs whitespace on both sides — and a `-` that starts the
  # NEXT value is not an operator at all.
  it 'reads a math operator only inside a math function' do
    expect(specified('width', 'calc(1px+2px)')).to      eq('')
    expect(specified('width', 'calc(1px + 2px)')).to    eq('calc(3px)')
    expect(specified('width', 'calc(1e+2px)')).to       eq('calc(100px)')
    expect(specified('inset', 'calc(10px - 0.5em) -20%')).not_to eq('')
  end
end
