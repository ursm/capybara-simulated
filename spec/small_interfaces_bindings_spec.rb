# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# MediaError and SVGAnimatedString, generated from their IDL: made by the platform alone, brands checked, state in
# slots. Headless Chrome's figures.
RSpec.describe 'MediaError and SVGAnimatedString bindings' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><svg><circle id=c class="a b"/></svg>']]
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what their IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const c = document.getElementById('c');
        const name = c.className;
        const read = [name.baseVal, name.animVal, name === c.className];
        name.baseVal = 5;
        const set = [c.getAttribute('class'), name.animVal];
        name.animVal = 'x';
        return [
          error(() => new MediaError()),
          [MediaError.MEDIA_ERR_DECODE, MediaError.prototype.MEDIA_ERR_SRC_NOT_SUPPORTED, Object.getOwnPropertyNames(MediaError.prototype).sort()],
          error(() => Object.getOwnPropertyDescriptor(MediaError.prototype, 'code').get.call({})),
          error(() => new SVGAnimatedString()),
          read,
          set,
          c.getAttribute('class'),
          Object.getOwnPropertyNames(SVGAnimatedString.prototype).sort(),
          error(() => Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, 'baseVal').get.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'MediaError': Illegal constructor",
      [3, 4, %w[MEDIA_ERR_ABORTED MEDIA_ERR_DECODE MEDIA_ERR_NETWORK MEDIA_ERR_SRC_NOT_SUPPORTED code constructor message]],
      'TypeError: Illegal invocation',
      "TypeError: Failed to construct 'SVGAnimatedString': Illegal constructor",
      ['a b', 'a b', true],
      %w[5 5],
      '5',
      %w[animVal baseVal constructor],
      'TypeError: Illegal invocation'
    ])
  end

  # BarProp and External are interfaces of their own, made by the platform alone: each bar of the window one BarProp
  # ([SameObject]), visible; External's two operations doing nothing.
  it 'gives the window its BarProps and its External' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        return [
          [typeof BarProp, typeof External, locationbar instanceof BarProp, locationbar === window.locationbar, toolbar.visible],
          [Object.prototype.toString.call(statusbar), Object.prototype.toString.call(external), external instanceof External],
          [external.AddSearchProvider(), external.IsSearchProviderInstalled()],
          error(() => new BarProp()), error(() => new External()),
          error(() => Object.getOwnPropertyDescriptor(BarProp.prototype, 'visible').get.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      ['function', 'function', true, true, true],
      ['[object BarProp]', '[object External]', true],
      [nil, nil],
      'TypeError', 'TypeError', 'TypeError'
    ])
  end

  # ValidityState and CustomStateSet are interfaces of their own, made by the platform alone: a control's validity a
  # live view ([SameObject]); a custom element's states a setlike<DOMString> (each value converted to a string) whose
  # mutations reach `:state()`.
  it 'gives a control its ValidityState and a custom element its CustomStateSet' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const input = document.createElement('input');
        input.required = true;
        const validity = input.validity;
        const before = [validity.valueMissing, validity.valid];
        input.value = 'x';
        class S extends HTMLElement { constructor() { super(); this.i = this.attachInternals(); } }
        customElements.define('x-states', S);
        const el = document.body.appendChild(new S());
        const states = el.i.states;
        states.add({toString: () => 'on'});
        const matched = el.matches(':state(on)');
        states.delete('on');
        return [
          [Object.prototype.toString.call(validity), validity === input.validity, before, validity.valueMissing, validity.valid, Object.keys(validity)],
          [Object.prototype.toString.call(states), states === el.i.states, matched, el.matches(':state(on)'), states.size, Object.keys(states)],
          [states.add('a') === states, [...states], states.has({toString: () => 'a'})],
          error(() => new ValidityState()), error(() => new CustomStateSet()),
          error(() => CustomStateSet.prototype.add.call(new Set(), 'x'))
        ];
      })()
    JS
    expect(got).to eq([
      ['[object ValidityState]', true, [true, false], false, true, []],
      ['[object CustomStateSet]', true, true, false, 0, []],
      [true, ['a'], true],
      'TypeError', 'TypeError', 'TypeError'
    ])
  end
end
