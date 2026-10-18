# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The custom element registries are the engine's (ce_reactions.rs): what a registry names by, which element a definition
# is for, and which registry a node has. These hold the edges of that against headless Chrome.
RSpec.describe 'custom element registries in the engine' do
  def session_for(pages)
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    s
  end

  # A definition goes with the realm that made it: an element of a frame's definition, adopted out of the frame, is
  # called back by no callback of it once the frame navigated away (Web IDL "check if we can run script": its realm's
  # document is not fully active). Chrome: nothing after the frame navigates.
  it "runs no callback of a definition whose realm's page was left" do
    frame = <<~HTML
      <!doctype html><meta charset=utf-8><body><script>
        customElements.define('x-f', class extends HTMLElement {
          static observedAttributes = ['a'];
          connectedCallback() { parent.__log.push('connected'); }
          disconnectedCallback() { parent.__log.push('disconnected'); }
          attributeChangedCallback(n, o, v) { parent.__log.push('attr ' + v); }
        });
      </script>
    HTML
    main = <<~HTML
      <!doctype html><meta charset=utf-8><body><iframe id=fr src="/frame"></iframe><script>
        window.__log = [];
        onload = () => {
          const fr = document.getElementById('fr'), fd = fr.contentDocument;
          window.__e = fd.createElement('x-f');
          fd.body.append(__e);
          document.body.append(__e);
          __log.length = 0;
          fr.src = '/other';
        };
      </script>
    HTML
    s = session_for('/' => main, '/frame' => frame, '/other' => '<!doctype html><body>other')
    s.within_frame('fr') { s.has_text?('other') }
    got = s.evaluate_script("(() => { __e.setAttribute('a', '2'); __e.remove(); document.body.append(__e); return __log; })()")
    expect(got).to eq([])
  end

  # …and its constructor constructs no element once the realm is gone — nor one custom by whichever definition took its
  # place in the engine. Chrome: ["TypeError"].
  it 'constructs no element of a definition whose realm is gone' do
    frame = <<~HTML
      <!doctype html><meta charset=utf-8><body><script>
        class X extends HTMLElement {}
        customElements.define('x-x', X);
        parent.X = X;
      </script>
    HTML
    main = '<!doctype html><meta charset=utf-8><body><iframe id=fr src="/frame"></iframe>'
    s = session_for('/' => main, '/frame' => frame)
    s.within_frame('fr') { s.has_css?('body') }
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('fr').remove();
        const log = [];
        customElements.define('y-y', class extends HTMLElement { connectedCallback() { log.push('Y connected'); } });
        try { document.body.append(new X()); } catch (e) { log.push(e.name); }
        return log;
      })()
    JS
    expect(got).to eq(['TypeError'])
  end

  # A name with a lone surrogate is its code units, not the U+FFFD a string makes of it: a definition named with the
  # replacement character is for neither. Chrome: [false, false, false].
  it 'keys a definition by the code units of its name' do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    got = s.evaluate_script(<<~JS)
      (() => {
        class A extends HTMLElement {}
        customElements.define('x-\\uFFFD', A);
        class B extends HTMLParagraphElement {}
        customElements.define('y-\\uFFFD', B, { extends: 'p' });
        return [
          document.createElement('x-\\uD800') instanceof A,
          customElements.get('x-\\uD800') === A,
          document.createElement('p', { is: 'y-\\uD800' }) instanceof B
        ];
      })()
    JS
    expect(got).to eq([false, false, false])
  end

  # A shadow root's node document is its host's, so with no registry set it has that document's window registry: none
  # for a host in a document without a browsing context. Chrome: [null, null].
  it "gives a shadow root its host's document's registry" do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const host = document.implementation.createHTMLDocument('').createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        return [host.customElementRegistry, root.customElementRegistry];
      })()
    JS
    expect(got).to eq([nil, nil])
  end

  # DOM "adopt" walks in tree order: a null element takes its parent's registry as the walk left it — a parent of the null
  # registry adopted into a window's leaves it the window's — and of that, the effective global one: none for a scoped
  # parent's (step 3.3.2). Chrome: ["window window window", "window null", "R window window"] — it departs from the spec
  # in both of the last two: the `<p>` asks its shadow root, which the walk has re-pointed, and a scoped parent's
  # effective global registry is none.
  it "gives a null element its parent's registry as the adopt left it" do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body><iframe id=fr srcdoc="<p>f</p>"></iframe>')
    s.within_frame('fr') { s.has_text?('f') }
    got = s.evaluate_script(<<~JS)
      (() => {
        const fw = document.getElementById('fr').contentWindow, fd = fw.document;
        const name = (r) => r === null ? 'null' : r === fw.customElements ? 'window' : r === customElements ? 'here' : 'R';
        const nul = (tag) => document.createElement(tag, { customElementRegistry: null });
        const a = nul('div'), b = a.appendChild(nul('span')), c = b.appendChild(nul('i'));
        fd.adoptNode(a);
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open', customElementRegistry: null });
        const p = root.appendChild(nul('p'));
        fd.adoptNode(host);
        const R = new CustomElementRegistry();
        const x = document.createElement('div', { customElementRegistry: R });
        const y = x.appendChild(nul('span')), z = y.appendChild(nul('i'));
        fd.adoptNode(x);
        return [[a, b, c].map((e) => name(e.customElementRegistry)).join(' '),
                [root, p].map((e) => name(e.customElementRegistry)).join(' '),
                [x, y, z].map((e) => name(e.customElementRegistry)).join(' ')];
      })()
    JS
    expect(got).to eq(['window window window', 'window window', 'R null null'])
  end

  # "Create an element for a token" looks its registry up through the intended parent, so a declarative shadow root of
  # the null registry holds elements of none even in a fragment parsed in a scoped registry's context — whether the
  # engine builds the parse or the bindings replay it (a lone surrogate in the markup). Chrome 155:
  # `scoped scoped null null null scoped` (Firefox has no scoped registries).
  it "gives a null-registry declarative shadow root's elements none in a scoped context" do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body><div id=h></div>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const r = new CustomElementRegistry();
        r.define('x-a', class extends HTMLElement {});
        const sr = document.getElementById('h').attachShadow({ mode: 'open', customElementRegistry: r });
        const name = (x) => (x === r ? 'scoped' : x === null ? 'null' : String(x));
        return ['', '\uD800'].map((lone) => {
          sr.innerHTML = '<div id=c></div>';
          const c = sr.getElementById('c');
          c.setHTMLUnsafe(`<div id=host><template shadowrootmode=open shadowrootcustomelementregistry>${lone}<x-a id=in></x-a>` +
                          '<p id=p></p></template></div><x-a id=out></x-a>');
          const host = c.querySelector('#host'), inner = host.shadowRoot;
          return [c, host, inner, inner.getElementById('in'), inner.getElementById('p'), c.querySelector('#out')]
            .map((n) => name(n.customElementRegistry)).join(' ');
        });
      })()
    JS
    expect(got).to eq(['scoped scoped null null null scoped'] * 2)
  end

  # A definition's disabled features are what `disabledFeatures` said when it was defined (HTML "define": its disable
  # internals and disable shadow flags) — the getter read once, a later answer of it changing nothing — and they are the
  # element's own registry's definition's, a scoped one's too, not the global registry's of that name.
  it 'disables the features its definition named when it was defined, in the element\'s own registry' do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    got = s.evaluate_script(<<~JS)
      (() => {
        let reads = 0, features = ['shadow', 'internals'];
        customElements.define('x-d', class extends HTMLElement { static get disabledFeatures() { reads++; return features; } });
        features = [];
        const refused = (f) => { try { f(); return 'ok'; } catch (e) { return e.name; } };
        const d = document.createElement('x-d');
        const own = [refused(() => d.attachShadow({ mode: 'open' })), refused(() => d.attachInternals()), reads];
        const scoped = new CustomElementRegistry();
        scoped.define('x-s', class extends HTMLElement { static disabledFeatures = ['shadow']; });
        customElements.define('x-s', class extends HTMLElement {});
        const inScoped = document.createElement('x-s', { customElementRegistry: scoped });
        const inGlobal = document.createElement('x-s');
        return own.concat(refused(() => inScoped.attachShadow({ mode: 'open' })), refused(() => inGlobal.attachShadow({ mode: 'open' })));
      })()
    JS
    expect(got).to eq(['NotSupportedError', 'NotSupportedError', 1, 'NotSupportedError', 'ok'])
  end
  # Whether an element is owed an upgrade is its custom element STATE's to say ("undefined" or "uncustomized"), not its
  # prototype's: one a page gave the class's prototype before the definition existed upgrades all the same — its
  # constructor runs and it is called back — and so does one whose prototype a page set back. Chrome: the log below.
  it 'upgrades by the custom element state, whatever prototype a page gave the element' do
    page = <<~HTML
      <!doctype html><meta charset=utf-8><body><script>
        window.__log = [];
        class XA extends HTMLElement { constructor() { super(); __log.push('ctor'); } connectedCallback() { __log.push('conn'); } }
        const a = document.createElement('x-a');
        Object.setPrototypeOf(a, XA.prototype);
        document.body.append(a);
        customElements.define('x-a', XA);
        __log.push(String(a.matches(':defined')));
        const b = document.createElement('div');
        b.innerHTML = '<x-c></x-c>';
        const c = b.firstChild;
        class XC extends HTMLElement { constructor() { super(); __log.push('ctorC'); } }
        customElements.define('x-c', XC);
        Object.setPrototypeOf(c, HTMLElement.prototype);
        customElements.upgrade(b);
        __log.push(String(c instanceof XC), String(c.matches(':defined')));
      </script>
    HTML
    s = session_for('/' => page)
    expect(s.evaluate_script('__log')).to eq(%w[ctor conn true ctorC true true])
  end
end
