# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CustomElementRegistry, generated from its IDL: its definitions in its slots, its arguments converted by the binding.
RSpec.describe 'CustomElementRegistry bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><iframe></iframe>']] })
    s.visit('/')
    s
  }

  def error(js) = "(() => { try { #{js}; return 'none'; } catch (e) { return e.name; } })()"

  it 'is what its IDL says' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const registry = new CustomElementRegistry();
        class A extends HTMLElement {}
        registry.define('x-a', A, {extends: undefined});
        const rejected = await registry.whenDefined('nope').then(() => 'none', (e) => e.name);
        const wrongThis = await CustomElementRegistry.prototype.whenDefined.call({}, 'x-b').then(() => 'none', (e) => e.name);
        const theirs = new frames[0].CustomElementRegistry();
        return [
          [Object.prototype.toString.call(registry), Object.keys(registry), Object.keys(customElements)],
          [registry.get('x-a') === A, registry.getName(A), registry.getName(class {}), customElements.get('x-a')],
          #{error("registry.define('x-c', () => {})")},
          #{error("registry.define('x-c', 1)")},
          #{error("registry.define('x-c', class extends HTMLElement {}, 1)")},
          #{error('registry.upgrade({})')},
          #{error('registry.getName({})')},
          rejected, wrongThis,
          document.createElement('x-a', {customElementRegistry: theirs}).customElementRegistry === theirs,
          #{error("document.createElement('x-a', {customElementRegistry: {define() {}, _scoped: true, _whenDefined: {}}})")}
        ];
      })().then(done, (e) => done(String(e)));
    JS
    expect(got).to eq([
      ['[object CustomElementRegistry]', [], []],
      [true, 'x-a', nil, nil],
      'TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError',
      'SyntaxError', 'TypeError',
      true,
      'TypeError'
    ])
  end
end
