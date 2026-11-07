require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "upgrade an element" when its constructor fails: the exception reported to the definition's global, as an invoked reaction's
# is; the element's prototype what the constructor left; a second construction of the definition within the one an upgrade is
# running a TypeError, its construction stack's top "already constructed". Chrome and Firefox do each (rvrt/p/n1).
RSpec.describe 'a custom element whose upgrade fails' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><div id="host"></div>']]
    }
  }
  let(:session) { simulated_session(app) }
  before { session.visit('/') }
  after { session.reset_session! }

  it 'reports what its constructor threw as `customElements.define` upgrades it' do
    expect(session.evaluate_script(<<~JS)).to eq(['RangeError', 'nope', false])
      (() => {
        host.innerHTML = '<x-throws></x-throws>';
        const seen = [];
        const onerror = (e) => { seen.push(e.error.name, e.error.message); e.preventDefault(); };
        window.addEventListener('error', onerror);
        customElements.define('x-throws', class extends HTMLElement { constructor() { super(); throw new RangeError('nope'); } });
        window.removeEventListener('error', onerror);
        seen.push(host.firstChild.matches(':defined'));
        return seen;
      })()
    JS
  end

  it 'keeps the prototype a constructor that never reached `super()` left' do
    expect(session.evaluate_script(<<~JS)).to eq(['ReferenceError', true])
      (() => {
        host.innerHTML = '<x-no-super></x-no-super>';
        let thrown;
        const onerror = (e) => { thrown = e.error.name; e.preventDefault(); };
        window.addEventListener('error', onerror);
        customElements.define('x-no-super', class extends HTMLElement { constructor() { } });
        window.removeEventListener('error', onerror);
        return [thrown, Object.getPrototypeOf(host.firstChild) === HTMLElement.prototype];
      })()
    JS
  end

  it 'has a second construction of the definition inside its upgrade throw' do
    expect(session.evaluate_script(<<~JS)).to eq([true, 'TypeError'])
      (() => {
        host.innerHTML = '<x-twice></x-twice>';
        let same, inner;
        class Twice extends HTMLElement {
          constructor() {
            const first = super();
            same = first === host.firstChild;
            try { new Twice(); } catch (e) { inner = e.name; }
          }
        }
        customElements.define('x-twice', Twice);
        return [same, inner];
      })()
    JS
  end

  it 'leaves an element made after its upgrade to a constructor of its own' do
    expect(session.evaluate_script(<<~JS)).to eq([true, true])
      (() => {
        host.innerHTML = '<x-later></x-later>';
        class Later extends HTMLElement {}
        customElements.define('x-later', Later);
        const made = new Later();
        return [made !== host.firstChild, made instanceof Later];
      })()
    JS
  end
end

RSpec.describe 'a structured clone' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><p>x</p>']]
    }
  }
  let(:session) { simulated_session(app) }
  before { session.visit('/') }
  after { session.reset_session! }

  it 'takes no Range' do
    expect(session.evaluate_script(<<~JS)).to eq('DataCloneError')
      (() => {
        try { structuredClone(new Range()); return 'cloned'; } catch (e) { return e.name; }
      })()
    JS
  end
end
