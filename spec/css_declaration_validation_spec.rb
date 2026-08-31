# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a declaration's grammar REJECTS. The property table is generated from mdn-data, and mdn
# writes a logical property's grammar as a reference to the physical one it mirrors
# (`padding-block-start` is `<'padding-top'>`, `block-size` is `<'width'>`) — a shape the classifier
# did not resolve, so 52 of the 471 longhands, all of them logical, carried no classification at
# all and accepted anything. `block-size: none` and `padding-block-start: -10px` were kept where
# every browser drops them.
#
# Every expectation is Chrome 151-measured on this machine: the value is assigned to `el.style` and
# read back, '' meaning the declaration was dropped.
RSpec.describe 'declaration validation' do
  def set(prop, value)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var e = document.createElement('div');
        e.style[#{prop.to_json}] = #{value.to_json};
        return e.style[#{prop.to_json}];
      })()
    JS
  end

  # A logical property validates exactly like the physical one mdn points it at.
  it 'takes a logical property to the grammar it mirrors' do
    expect(set('blockSize', '10px')).to        eq('10px')
    expect(set('blockSize', 'min-content')).to eq('min-content')
    expect(set('blockSize', 'none')).to        eq('')
    expect(set('paddingBlockStart', '10px')).to  eq('10px')
    expect(set('paddingBlockStart', '-10px')).to eq('')   # padding's `[0,∞]` range
  end

  # A grammar that takes the value up to N times (`<'border-top-color'>{1,2}`) accepts that many
  # and no more, each judged on its own.
  it 'counts the values a repeated grammar takes' do
    expect(set('borderBlockColor', 'red blue')).to       eq('red blue')
    expect(set('borderBlockColor', 'red blue green')).to eq('')
    expect(set('blockSize', '1px 2px')).to               eq('')
  end

  # …counted at the TOP level, so the spaces inside a function are not separators — and a value
  # that is still two components is invalid whatever the second one would resolve to.
  it 'counts a function as one value' do
    expect(set('paddingInlineStart', 'calc(10px - 0.5em)')).to     eq('calc(10px - 0.5em)')
    expect(set('paddingInlineStart', '20% calc(10px - 0.5em)')).to eq('')
  end

  # None of these grammars is comma-separated, so a comma is a parse error wherever it falls.
  it 'rejects a comma in a space-separated grammar' do
    expect(set('marginBlock', '20%, calc(10px - 0.5em)')).to eq('')
  end

  # A classified property's keyword list is its WHOLE list — an identifier outside it is invalid
  # however common the word is on other properties.
  it 'rejects an identifier the property does not list' do
    expect(set('paddingBlockStart', 'none')).to eq('')
    expect(set('borderBlockStartColor', 'auto')).to eq('')
    expect(set('baselineShift', 'sub')).to eq('sub')
    # …including SVG 1.1's `top` / `center` / `bottom`, which css-inline-3 dropped and Chrome 151
    # drops with it (the WPT `serialize-values` case that still lists them is earned out).
    expect(set('baselineShift', 'top')).to eq('')
  end

  # The four classic colour functions have a settled grammar and the vendored parser reads them, so
  # a malformed one is dropped — while a function it does not know yet must NOT be.
  it 'judges the classic colour functions and no others' do
    expect(set('borderBlockStartColor', 'rgb(1,2,3)')).not_to eq('')
    expect(set('borderBlockStartColor', 'rgb(1,2,3,4,5)')).to eq('')
    expect(set('borderBlockStartColor', 'rgb(10%, 20, 30%)')).to eq('')
    expect(set('borderBlockEndColor', 'rgb(1)')).to eq('')
    expect(set('borderBlockEndColor', '123')).to eq('')
    expect(set('borderBlockEndColor', 'color-mix(in srgb, red, blue)'))
      .to eq('color-mix(in srgb, red, blue)')
  end

  # A shorthand is invalid when any component it expands to is, and the WHOLE declaration goes.
  it 'drops a shorthand whose component is invalid' do
    expect(set('marginBlock', 'none')).to   eq('')
    expect(set('marginBlock', '1px 2px')).to eq('1px 2px')
    expect(set('paddingBlock', '-1px')).to  eq('')
  end

  # …but not while a substitution is unresolved: the expanders cannot split `var(--one) var(--two)`
  # into sides before it resolves, so the shorthand is kept whole and the sides report nothing.
  it 'leaves an unresolved substitution alone' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq(['', 'var(--one) var(--two)'])
      (function () {
        var e = document.createElement('div');
        e.style.marginInline = 'var(--one) var(--two)';
        return [e.style.marginInlineStart, e.style.marginInline];
      })()
    JS
  end

  # A value the parser can't fully read is not a value it may DROP: a `var()` or `calc()` inside a
  # colour function, the relative-colour `from`, or a comment all put it past the vendored parser,
  # which answers "not a colour" for every one of them. Judging those took out the whole Tailwind
  # colour system (241 declarations across the five app suites' CSS, all of which Chrome keeps).
  it 'only judges a colour function whose arguments are literal' do
    expect(set('backgroundColor', 'rgb(255 255 255 / var(--tw-bg-opacity, 1))'))
      .not_to eq('')
    expect(set('color', 'rgb(1 2 3 / calc(0.5))')).not_to eq('')
    expect(set('color', 'rgb(from red r g b)')).not_to  eq('')
    expect(set('border', '1px solid rgb(0 0 0 / calc(0.5))')).not_to eq('')
  end

  # …and how MANY values something is cannot be decided while a substitution is unresolved either.
  it 'defers arity while a substitution is unresolved' do
    expect(set('paddingLeft', 'var(--a) var(--b)')).not_to eq('')
    expect(set('width', 'var(--a) var(--b)')).not_to eq('')
  end

  # mdn-data lags Chrome on a few keywords, and a classified property's list is treated as complete
  # — so those have to be named, or `width: stretch` (the standard `-webkit-fill-available`) goes.
  it 'keeps the keywords mdn has yet to record' do
    expect(set('width', 'stretch')).to eq('stretch')
    expect(set('minHeight', 'stretch')).to eq('stretch')
    expect(set('gridColumnGap', 'normal')).to eq('normal')
  end

  # The three surfaces have to agree: the per-property setter, the block parse behind
  # `setAttribute('style', …)` / `cssText`, and the cascade. Chrome's `cssText` comes back empty for
  # each of these while the attribute keeps its text verbatim.
  it 'drops the same declaration through the block parse' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq([['padding-block: none', ''], ['color: 123', ''], ['width: 10px', 'width: 10px;']])
      ['padding-block: none', 'color: 123', 'width: 10px'].map(function (css) {
        var e = document.createElement('div');
        e.setAttribute('style', css);
        return [e.getAttribute('style'), e.style.cssText];
      })
    JS
  end

  # `inset` is the box shorthand over the four PHYSICAL inset longhands — whose names are the bare
  # `top` / `right` / `bottom` / `left`, which is why it could not be spelled like the other box
  # families and was missing from the CSSOM registry entirely.
  it 'expands the inset shorthand into the physical longhands' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq(['1px 2px 3px 4px', '1px', '2px', '3px', '4px'])
      (function () {
        var e = document.createElement('div');
        e.style.inset = '1px 2px 3px 4px';
        return [e.style.inset, e.style.top, e.style.right, e.style.bottom, e.style.left];
      })()
    JS
  end
end
