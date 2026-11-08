# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element's custom element state (HTML §4.13) is the engine's (ce_reactions.rs `ceUpgrade` / `ceUpgradeEnd`): "failed"
# as an upgrade begins, "precustomized" as its constructor runs, "custom" once it returned the element — and a
# constructor's own element "custom" from its `super()`. What a state gives (its callbacks, `:defined`,
# attachInternals) follows it. Chrome 157 and Firefox 159 agree on each figure below but where one says otherwise.
RSpec.describe 'a custom element state' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><div id="host"></div>']]
    }
  }
  let(:session) { simulated_session(app) }
  before { session.visit('/') }
  after { session.reset_session! }

  # DOM "remove" and "insert" call back a CUSTOM element; one its upgrade is constructing is "precustomized", owed the
  # connectedCallback its upgrade enqueued and nothing for its own removal and insertion.
  it 'owes an element its upgrade is constructing no callback for a move its constructor makes' do
    expect(session.evaluate_script(<<~JS)).to eq(['ctor false', 'connected'])
      (() => {
        host.innerHTML = '<x-mover></x-mover>';
        const log = [];
        customElements.define('x-mover', class extends HTMLElement {
          constructor() {
            super();
            log.push('ctor ' + this.matches(':defined'));
            const parent = this.parentNode;
            this.remove();
            parent.append(this);
          }
          connectedCallback() { log.push('connected'); }
          disconnectedCallback() { log.push('disconnected'); }
        });
        return log;
      })()
    JS
  end

  # "create an element" constructs custom: its HTML element constructor makes the element "custom" in its `super()`.
  it 'makes the element createElement constructs custom from its super()' do
    expect(session.evaluate_script(<<~JS)).to eq([true, 'attached'])
      (() => {
        const seen = [];
        customElements.define('x-made', class extends HTMLElement {
          constructor() {
            super();
            seen.push(this.matches(':defined'));
            try { this.attachInternals(); seen.push('attached'); } catch (e) { seen.push(e.name); }
          }
        });
        document.createElement('x-made');
        return seen;
      })()
    JS
  end

  # …but a customized built-in it makes the built-in element and upgrades (DOM "create an element" step 5.2):
  # "precustomized" in its constructor, and where that throws the same element, "failed", the class's prototype kept.
  # Chrome and Firefox: `[false, true, true, false]`, and `false` in a constructor that returns.
  it 'upgrades the customized built-in createElement makes' do
    expect(session.evaluate_script(<<~JS)).to eq([false, true, true, false, false, true])
      (() => {
        let made, inThrowing, inReturning;
        customElements.define('x-thrower', class Thrower extends HTMLButtonElement {
          constructor() { super(); made = this; inThrowing = this.matches(':defined'); throw new Error('no'); }
        }, {extends: 'button'});
        customElements.define('x-fine', class extends HTMLButtonElement {
          constructor() { super(); inReturning = this.matches(':defined'); }
        }, {extends: 'button'});
        const onerror = (e) => e.preventDefault();
        window.addEventListener('error', onerror);
        const failed = document.createElement('button', {is: 'x-thrower'});
        window.removeEventListener('error', onerror);
        const fine = document.createElement('button', {is: 'x-fine'});
        return [inThrowing, failed === made, failed instanceof customElements.get('x-thrower'), failed.matches(':defined'),
          inReturning, fine.matches(':defined')];
      })()
    JS
  end

  # HTML "create an element for the token": a customized built-in the parser makes is constructed as it is made, by its
  # `is` attribute's definition — empty, no parent — its attributes appended after (their reactions then). Chrome and
  # Firefox: `ctor 0 false`, then the attribute's change, then the connection.
  it 'constructs the customized built-in the parser makes as it makes it' do
    page = <<~HTML
      <!doctype html><meta charset="utf-8"><body><script>
        window.log = [];
        customElements.define('x-pbtn', class extends HTMLButtonElement {
          static observedAttributes = ['t'];
          constructor() { super(); log.push('ctor ' + this.attributes.length + ' ' + !!this.parentNode); }
          attributeChangedCallback(n, o, v) { log.push('attr ' + v); }
          connectedCallback() { log.push('connected'); }
        }, {extends: 'button'});
      </script><button is="x-pbtn" t="1">b</button>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(s.evaluate_script('log')).to eq(['ctor 0 false', 'attr 1', 'connected'])
  end

  # HTML's HTML element constructor finds its NewTarget's definition in the registry its construction is of (the active
  # custom element constructor map's — an upgrade's, "create an element"'s — else the window's), not the latest
  # definition of the constructor anywhere: a class a scoped registry also defines, autonomously, still constructs the
  # customized built-in the window registry defines it as. Chrome and Firefox: all `true`.
  it "constructs by the definition of the registry its construction is of" do
    expect(session.evaluate_script(<<~JS)).to eq([true, true, true])
      (() => {
        class Shared extends HTMLButtonElement {}
        customElements.define('x-shared', Shared, {extends: 'button'});
        new CustomElementRegistry().define('x-scoped-auto', Shared);
        host.insertAdjacentHTML('beforeend', '<button is="x-shared"></button>');
        return [document.createElement('button', {is: 'x-shared'}) instanceof Shared, new Shared() instanceof Shared,
          host.lastChild instanceof Shared];
      })()
    JS
  end

  # attachInternals step 6: a NotSupportedError for an element neither "precustomized" nor "custom" — one made before
  # its definition and never upgraded ("undefined"), or the one a failed construction made in its stead ("failed").
  it 'attaches no internals to an undefined element, nor a failed one' do
    expect(session.evaluate_script(<<~JS)).to eq(%w[NotSupportedError NotSupportedError])
      (() => {
        const early = document.createElement('x-early');
        customElements.define('x-early', class extends HTMLElement {});
        customElements.define('x-broken', class extends HTMLElement { constructor() { super(); throw new Error('no'); } });
        const onerror = (e) => e.preventDefault();
        window.addEventListener('error', onerror);
        const broken = document.createElement('x-broken');
        window.removeEventListener('error', onerror);
        return [early, broken].map((el) => { try { el.attachInternals(); return 'attached'; } catch (e) { return e.name; } });
      })()
    JS
  end

  # HTML "upgrade an element": a constructor that throws leaves the element "precustomized" (its state set before the
  # constructor runs, and not set back), to which attachInternals still attaches. Chrome does; Firefox makes it
  # "failed" and refuses, which the spec's note ("will remain 'failed' or 'precustomized'") does not.
  it 'leaves an element whose upgrade threw precustomized' do
    expect(session.evaluate_script(<<~JS)).to eq([false, 'attached'])
      (() => {
        host.innerHTML = '<x-throws></x-throws>';
        const onerror = (e) => e.preventDefault();
        window.addEventListener('error', onerror);
        customElements.define('x-throws', class extends HTMLElement { constructor() { super(); throw new Error('no'); } });
        window.removeEventListener('error', onerror);
        const el = host.firstChild;
        let attached;
        try { el.attachInternals(); attached = 'attached'; } catch (e) { attached = e.name; }
        return [el.matches(':defined'), attached];
      })()
    JS
  end

  # …and step 9.1: a definition that disables shadow roots fails the upgrade of an element that has one, before its
  # constructor runs — "failed", the NotSupportedError reported.
  it 'fails the upgrade of a shadow host whose definition disables shadow roots' do
    expect(session.evaluate_script(<<~JS)).to eq(['NotSupportedError', 0, false])
      (() => {
        host.innerHTML = '<x-shadowed></x-shadowed>';
        host.firstChild.attachShadow({mode: 'open'});
        let thrown, made = 0;
        const onerror = (e) => { thrown = e.error.name; e.preventDefault(); };
        window.addEventListener('error', onerror);
        customElements.define('x-shadowed', class extends HTMLElement {
          static disabledFeatures = ['shadow'];
          constructor() { super(); made++; }
        });
        window.removeEventListener('error', onerror);
        return [thrown, made, host.firstChild.matches(':defined')];
      })()
    JS
  end
end

# The construction stack an upgrade's `super()` finds its element on is the agent's (ce_reactions.rs `constructing`):
# an element of the parent's that the parser of a FRAME's document makes, or that goes into one, is upgraded by the
# frame's definition — its constructor's `super()` the frame realm's HTMLElement. Chrome and Firefox: upgraded, at once.
RSpec.describe 'a custom element upgraded across realms' do
  it "upgrades a parent's element in a frame's document by the frame's definition" do
    frame = <<~HTML
      <!doctype html><meta charset=utf-8><body><script>
        customElements.define('x-ce', class XCe extends HTMLElement { constructor() { super(); this.made = true; } });
      </script>
    HTML
    pages = {'/' => '<!doctype html><meta charset=utf-8><body><iframe id=fr src="/frame"></iframe>', '/frame' => frame}
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    s.within_frame('fr') { s.has_css?('body') }
    got = s.evaluate_script(<<~JS)
      (() => {
        const fr = document.getElementById('fr'), fw = fr.contentWindow, fd = fr.contentDocument;
        const XCe = fw.customElements.get('x-ce');
        const parsed = document.createElement('div');
        fd.body.append(parsed);
        parsed.innerHTML = '<x-ce></x-ce>';
        const moved = document.createElement('div');
        moved.innerHTML = '<x-ce></x-ce>';
        fd.body.append(moved);
        return [parsed.firstChild, moved.firstChild].map((el) => [el instanceof XCe, el.made === true]);
      })()
    JS
    expect(got).to eq([[true, true], [true, true]])
  end
end
