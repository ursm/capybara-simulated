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

  # HTML's steps: upgrade() upgrades only this registry's elements (Chrome: the same); whenDefined's promises are the
  # realm's own, whatever a page put in Promise's place (Chrome, Firefox: native); a scoped registry defines no
  # customized built-in; the global one initializes only a tree of its own document; initialize reads a shadow root's
  # registry as it is, not through a page's getter (Chrome: not run); and a frame's registry, called through this
  # realm's interface, upgrades the frame's elements.
  it "follows HTML's registry steps" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const div = document.createElement('div');
        div.innerHTML = '<x-h></x-h>';
        class H extends HTMLElement {}
        customElements.define('x-h', H);
        new CustomElementRegistry().upgrade(div);
        const otherUpgraded = div.firstChild instanceof H;
        customElements.upgrade(div);
        const ownUpgraded = div.firstChild instanceof H;
        const own = window.Promise;
        window.Promise = function Fake() {};
        window.Promise.resolve = () => 'fake';
        const promises = [customElements.whenDefined('x-zz'), customElements.whenDefined('nope'), customElements.whenDefined('x-h')];
        window.Promise = own;
        promises[1].catch(() => {});
        const host = document.createElement('div');
        const root = host.attachShadow({mode: 'open', customElementRegistry: null});
        let ran = false;
        Object.defineProperty(root, 'customElementRegistry', {get() { ran = true; return null; }});
        new CustomElementRegistry().initialize(root);
        const frame = frames[0];
        const el = frame.document.createElement('x-f');
        frame.document.body.append(el);
        CustomElementRegistry.prototype.define.call(frame.customElements, 'x-f', class extends frame.HTMLElement {});
        return [
          otherUpgraded, ownUpgraded,
          promises.map((p) => p instanceof own),
          #{error("new CustomElementRegistry().define('x-s', class extends HTMLButtonElement {}, {extends: 'button'})")},
          #{error("customElements.initialize(document.implementation.createHTMLDocument('').createElement('div'))")},
          #{error('customElements.initialize(frames[0].document.body)')},
          ran,
          el.constructor !== frame.HTMLElement
        ];
      })()
    JS
    expect(got).to eq([false, true, [true, true, true], 'NotSupportedError', 'NotSupportedError', 'NotSupportedError', false, true])
  end
end
