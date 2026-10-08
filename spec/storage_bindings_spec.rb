# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Storage, generated from its IDL: no constructor, its arguments converted, its brand checked — and an area's named
# properties running its operations, not members a page may have replaced. The figures are headless Chrome's.
RSpec.describe 'Storage bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']] })
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        localStorage.clear();
        const out = [
          error(() => new Storage()),
          error(() => localStorage.setItem(Symbol(), 'x')),
          error(() => localStorage.getItem()),
          error(() => Storage.prototype.getItem.call({}, 'k')),
          error(() => { localStorage.q = Symbol(); }),
          Object.prototype.toString.call(localStorage),
          Object.getOwnPropertySymbols(localStorage).length
        ];
        const { getItem, setItem } = Storage.prototype;
        Storage.prototype.getItem = () => 'PAGE';
        Storage.prototype.setItem = () => {};
        localStorage.k = 'v';
        out.push(localStorage.k, 'k' in localStorage, Object.keys(localStorage));
        Object.assign(Storage.prototype, { getItem, setItem });
        localStorage.clear();
        return out;
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'Storage': Illegal constructor",
      "TypeError: Failed to execute 'setItem' on 'Storage': Cannot convert a Symbol value to a string",
      "TypeError: Failed to execute 'getItem' on 'Storage': 1 argument required, but only 0 present.",
      'TypeError: Illegal invocation',
      "TypeError: Failed to set a named property 'q' on 'Storage': Cannot convert a Symbol value to a string",
      '[object Storage]', 0,
      'v', true, ['k']
    ])
  end

  # Web IDL's legacy platform object steps (§3.9): Chrome's figures, but for a defineProperty of `{}` (no data
  # descriptor — refused; Chrome stores "undefined") and a hidden name in getOwnPropertyNames (only visible names are
  # own keys; Chrome lists it).
  it 'answers its named properties as a legacy platform object' do
    got = session.evaluate_script(<<~JS)
      (() => {
        localStorage.clear();
        localStorage.setItem('getItem', 'x');
        const out = [delete localStorage.getItem, localStorage.getItem('getItem'), Reflect.preventExtensions(localStorage), Object.isExtensible(localStorage)];
        const derived = Object.create(localStorage);
        derived.z = 'w';
        out.push(localStorage.getItem('z'), Object.hasOwn(derived, 'z'));
        out.push(Reflect.defineProperty(localStorage, 'y', {writable: true}), localStorage.getItem('y'));
        out.push(Reflect.defineProperty(localStorage, 'e', {}), localStorage.getItem('e'));
        localStorage[Symbol('s')] = 1;
        out.push(Object.getOwnPropertySymbols(localStorage).length, Object.getOwnPropertyNames(localStorage).sort());
        localStorage.clear();
        return out;
      })()
    JS
    expect(got).to eq([true, 'x', false, true, nil, true, true, 'undefined', false, nil, 1, ['y']])
  end
end
