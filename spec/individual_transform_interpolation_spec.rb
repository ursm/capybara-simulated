# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `translate`, `rotate` and `scale` are one transform each, not a function list (css-transforms-2 §"Individual
# Transform Properties"), and the driver read them as a list it could not parse — so every animation of one flipped
# discretely. Each mixes, adds and accumulates as the transform it is, with `none` standing in as the other end's
# identity. Figures are Chrome 151-measured, and Firefox agrees, EXCEPT the scale ACCUMULATION, where Chrome
# multiplies and the spec (css-transforms-2 §15, one-based values: `Va + Vb - 1`) and Firefox add.
RSpec.describe 'interpolating the individual transform properties' do
  def values(*cases)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      #{cases.to_json}.map(([style, prop, keyframes, time, composite]) => {
        const e = document.body.appendChild(document.createElement('div'));
        e.setAttribute('style', style);
        const a = e.animate(keyframes, { duration: 1000, composite: composite || 'replace' });
        a.pause();
        a.currentTime = time;
        return getComputedStyle(e)[prop];
      })
    JS
  end

  # The computed value an interpolation is compared against: an axis along X, Y or Z is its keyword (Z none at all,
  # and one pointing backwards turns the angle round), an angle is in degrees, a trailing zero or a repeated scale
  # factor is not written.
  it 'computes each value in the canonical form' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq(
      [['rotate', '0 0 -1 30deg'], ['rotate', '2 0 0 10deg'], ['rotate', '1 1 0 0.5turn'], ['rotate', 'x 1rad'],
       ['rotate', '0 0 0 10deg'], ['translate', '10px 0px 0px'], ['translate', '0% 0px'], ['translate', '10px 0%'],
       ['scale', '2 2 1'], ['scale', '50%'], ['scale', '2 3 1'], ['rotate', '45deg x'],
       ['translate', 'calc(10px + 5%) 0px 0px'], ['translate', 'calc(min(10%, 50px))'], ['scale', 'calc(50%) 1 1']].map(([prop, value]) => {
        const e = document.body.appendChild(document.createElement('div'));
        e.style[prop] = value;
        return getComputedStyle(e)[prop];
      })
    JS
      ['-30deg', 'x 10deg', '1 1 0 180deg', 'x 57.2958deg', '0 0 0 10deg', '10px', '0%', '10px 0%', '2', '0.5', '2 3',
       'x 45deg', 'calc(5% + 10px)', 'min(10%, 50px)', '0.5 1']
    )
  end

  # A transition reads the two computed values, so every spelling the grammar allows has to reach the interpolation:
  # an `em` / `calc()` translation, an angle written before its axis, a scale in percent — each of which flipped
  # discretely (and so never started) where Chrome and Firefox transition.
  def transition_midpoint(prop, from, to)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        const d = document.body.appendChild(document.createElement('div'));
        d.style.cssText = 'width: 100px; font-size: 10px';
        d.style.setProperty(#{prop.to_json}, #{from.to_json});
        getComputedStyle(d)[#{prop.to_json}];
        d.style.transition = #{prop.to_json} + ' 10s linear -5s';
        d.style.setProperty(#{prop.to_json}, #{to.to_json});
        return getComputedStyle(d).getPropertyValue(#{prop.to_json});
      })()
    JS
  end

  it 'transitions every spelling the grammar allows' do
    expect(transition_midpoint('translate', '1em', '20px 3em')).to eq('15px 15px')
    expect(transition_midpoint('translate', '10%', 'calc(20px + 10%) 5px')).to eq('calc(10% + 10px) 2.5px')
    expect(transition_midpoint('rotate', '45deg x', '90deg y')).to eq('0.475963 0.879465 0 52.4834deg')
    expect(transition_midpoint('scale', '50%', '150% 200%')).to eq('1 1.25')
  end

  # Keeping every digit of an endpoint: `x 1rad` is 57.29578°, and mixed from the six digits its computed value
  # reports it came to `x 42.9719deg` half way from `0.5rad` (Chrome: 42.9718).
  it 'mixes an endpoint unrounded' do
    expect(values(['', 'rotate', [{rotate: '1 0 0 0.5rad'}, {rotate: 'x 1rad'}], 500])).to eq(['x 42.9718deg'])
  end

  # Only a value of the grammar is one: an invalid keyframe is dropped (Chrome and Firefox: `x 85deg`, from the
  # underlying `none` — here `x 0deg` on the axis of the other end), and the declaration too.
  it 'drops a value outside the grammar' do
    expect(values(['', 'rotate', [{rotate: 'x 170deg'}, {rotate: '-x 170deg'}], 500])).to eq(['x 85deg'])
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    expect(session.evaluate_script(<<~JS)).to eq(['', '', '', '', '', 'x 45deg', '0.5 2'])
      [['rotate', '-x 170deg'], ['rotate', '10deg 20deg'], ['translate', '10px 20px 30%'], ['translate', '10deg'],
       ['scale', '2px'], ['rotate', '45deg x'], ['scale', '50% 2']].map(([prop, value]) => {
        const e = document.createElement('div');
        e.style[prop] = value;
        return e.style[prop];
      })
    JS
  end

  it 'mixes a translation component by component, from none as 0px' do
    expect(values(
      ['', 'translate', [{translate: '10px'}, {translate: '20px 10px'}], 500],
      ['', 'translate', [{translate: 'none'}, {translate: '20px 10px 4px'}], 500],
      ['', 'translate', [{translate: 'none'}, {translate: '10px'}], 0],
      ['', 'translate', [{translate: '10%'}, {translate: '20px 5px'}], 500]
    )).to eq(['15px 5px', '10px 5px 2px', '0px', 'calc(5% + 10px) 2.5px'])
  end

  it 'mixes a scale factor by factor, from none as 1' do
    expect(values(
      ['', 'scale', [{scale: '1'}, {scale: '3 2'}], 500],
      ['', 'scale', [{scale: 'none'}, {scale: '3'}], 500],
      ['', 'scale', [{scale: '2 3 4'}, {scale: 'none'}], 500]
    )).to eq(['2 1.5', '2', '1.5 2 2.5'])
  end

  it 'mixes the angle about a shared axis, and slerps between two axes' do
    expect(values(
      ['', 'rotate', [{rotate: '45deg'}, {rotate: 'z 90deg'}], 500],
      ['', 'rotate', [{rotate: 'x 180deg'}, {rotate: 'x 540deg'}], 500],
      ['', 'rotate', [{rotate: 'x 0deg'}, {rotate: 'y 90deg'}], 500],
      ['', 'rotate', [{rotate: 'none'}, {rotate: '1 1 0 90deg'}], 500],
      ['', 'rotate', [{rotate: '1 0 0 90deg'}, {rotate: '0 0 1 90deg'}], 500],
      ['', 'rotate', [{rotate: '0.25turn'}, {rotate: '1 0 0 0.5turn'}], 500],
      ['', 'rotate', [{rotate: '0 0 -1 30deg'}, {rotate: '0 0 1 30deg'}], 500]
    )).to eq(['67.5deg', 'x 360deg', 'y 45deg', '0.707107 0.707107 0 45deg', '0.707107 0 0.707107 70.5288deg',
              '0.816497 0 0.57735 120deg', '0deg'])
  end

  it 'adds a translation, multiplies a scale, and composes a rotation onto the underlying one' do
    expect(values(
      ['translate: 10%', 'translate', [{translate: '5px 3px'}, {translate: '5px 3px'}], 500, 'add'],
      ['scale: 2', 'scale', [{scale: '3'}, {scale: '3'}], 500, 'add'],
      ['rotate: 300deg', 'rotate', [{rotate: '300deg'}, {rotate: '300deg'}], 500, 'add'],
      ['rotate: x 300deg', 'rotate', [{rotate: 'y 30deg'}, {rotate: 'y 30deg'}], 500, 'add']
    )).to eq(['calc(10% + 5px) 3px', '6', '600deg', '-0.881412 0.409065 -0.236174 66.4519deg'])
  end

  it 'accumulates a scale as one-based values, and a rotation as it adds' do
    expect(values(
      ['scale: 2 1', 'scale', [{scale: '2'}, {scale: '2'}], 500, 'accumulate'],
      ['rotate: x 45deg', 'rotate', [{rotate: 'y 45deg'}, {rotate: 'y 45deg'}], 500, 'accumulate']
    )).to eq(['3 2', '0.678598 0.678598 0.281085 62.7994deg'])
  end
end
