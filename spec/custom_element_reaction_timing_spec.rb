# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An attributeChanged reaction runs when the API call that caused it returns ([CEReactions]) — after the attribute's
# change steps, so the callback sees the handler installed, the option's selectedness set, an input's value migrated
# by its type change. And it names the attribute by LOCAL name with its namespace: `setAttributeNS('urn:x', 'p:q')`
# calls back `q` in `urn:x`. Chrome-measured.
RSpec.describe 'custom element reaction timing' do
  it 'calls attributeChangedCallback after the change steps, with local name and namespace' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><select id="s"><option value="a" selected>a</option></select>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const log = [];
        class X extends HTMLElement {
          static get observedAttributes() { return ['onclick', 'q']; }
          attributeChangedCallback(n, o, v, ns) { log.push(n === 'onclick' ? typeof this.onclick : n + ':' + o + '>' + v + '@' + ns); }
        }
        customElements.define('x-e', X);
        const e = document.createElement('x-e');
        document.body.append(e);
        e.setAttribute('onclick', 'void 0'); e.removeAttribute('onclick');
        e.setAttributeNS('urn:x', 'p:q', '1');
        class O extends HTMLOptionElement {
          static get observedAttributes() { return ['selected']; }
          attributeChangedCallback() { log.push(this.selected + ':' + document.getElementById('s').value); }
        }
        customElements.define('x-o', O, { extends: 'option' });
        const o = document.createElement('option', { is: 'x-o' });
        o.value = 'b'; o.textContent = 'b';
        document.getElementById('s').append(o);
        o.setAttribute('selected', ''); o.removeAttribute('selected');
        class T extends HTMLInputElement {
          static get observedAttributes() { return ['type']; }
          attributeChangedCallback() { log.push(this.getAttribute('value') + ':' + this.value); }
        }
        customElements.define('x-t', T, { extends: 'input' });
        const ti = document.createElement('input', { is: 'x-t' });
        document.body.append(ti);
        ti.value = 'vv'; ti.setAttribute('type', 'checkbox');
        return log;
      })()
    JS
    expect(got).to eq(['function', 'object', 'q:null>1@urn:x', 'true:b', 'false:a', 'vv:vv'])
  end

  # Only a write a step makes ITSELF joins the reaction queue of the change it belongs to; a write from page code a step
  # calls into — a form-associated callback, a `blur` listener — is an API call of its own, and calls back before it
  # returns. An upgrade calls back for a namespaced attribute by local name and namespace too. Chrome-measured (Chrome
  # blurs a newly disabled element later, a separate difference; the order inside the listener is what is held here).
  it 'calls back before a write from page code a step runs returns, and on upgrade by local name' do
    html = <<~HTML
      <!DOCTYPE html><fieldset id="fs"><x-f id="xf"></x-f></fieldset><button id="btn">b</button><x-u id="xu"></x-u>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const R = {};
        { const log = [];
          class F extends HTMLElement {
            static formAssociated = true;
            static get observedAttributes() { return ['d']; }
            attributeChangedCallback(n, o, v) { this._d = v; log.push('acb:' + v); }
            formDisabledCallback(dis) { log.push('fdc:' + dis); this.setAttribute('d', String(dis)); log.push('after:' + this._d); }
          }
          customElements.define('x-f', F);
          log.length = 0;
          document.getElementById('fs').setAttribute('disabled', '');
          R.face = log; }
        { const log = [];
          class B extends HTMLElement {
            static get observedAttributes() { return ['z']; }
            attributeChangedCallback(n, o, v) { this._z = v; log.push('acb:' + v); }
          }
          customElements.define('x-b', B);
          const xb = document.createElement('x-b');
          document.body.append(xb);
          const btn = document.getElementById('btn');
          btn.focus();
          btn.addEventListener('blur', () => { xb.setAttribute('z', '1'); log.push('in-blur:' + xb._z); });
          btn.setAttribute('disabled', '');
          R.blur = log; }
        { const log = [];
          const u = document.getElementById('xu');
          u.setAttributeNS('urn:x', 'foo', '1'); u.setAttributeNS('urn:x', 'p:bar', '2'); u.setAttribute('baz', '3');
          class U extends HTMLElement {
            static get observedAttributes() { return ['foo', 'bar', 'baz']; }
            attributeChangedCallback(n, o, v, ns) { log.push(n + ':' + o + '>' + v + '@' + ns); }
          }
          customElements.define('x-u', U);
          R.upgrade = log; }
        return R;
      })()
    JS
    expect(got['face']).to eq(%w[fdc:true acb:true after:true])
    expect(got['blur']).to eq(%w[acb:1 in-blur:1])
    expect(got['upgrade']).to eq(['foo:null>1@urn:x', 'bar:null>2@urn:x', 'baz:null>3@null'])
  end

  # The definition is looked up by the local name as created: `createElement` has ASCII-lowercased it, and a
  # non-ASCII capital stays (`x-Ö` upgrades from createElement and createElementNS alike, as from the parser).
  it 'looks a definition up by the exact local name' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ['<!DOCTYPE html><p>x</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        class Y extends HTMLElement {}
        customElements.define('x-Ö', Y);
        return [document.createElement('x-Ö') instanceof Y, document.createElementNS('http://www.w3.org/1999/xhtml', 'x-Ö') instanceof Y,
                document.createElement('x-Ö').localName];
      })()
    JS
    expect(got).to eq([true, true, 'x-Ö'])
  end

  # A shadow tree the parser's custom element built in its constructor connects once, each element of it: one a
  # `connectedCallback` inserts beside it is connected by its own insertion, not again by the walk that found its
  # sibling (it read the tree live, and called back the inserted one twice). Chrome: ["xa=1", "xb=n1", "end=1"].
  it "calls back an element a shadow tree's callback inserts once" do
    html = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><script>
        window.log = [];
        customElements.define('x-a', class extends HTMLElement {
          connectedCallback() { log.push('xa=1'); const b = document.createElement('x-b'); b.id = 'n1'; this.after(b); }
        });
        customElements.define('x-b', class extends HTMLElement { connectedCallback() { log.push('xb=' + this.id); } });
        customElements.define('x-host', class extends HTMLElement {
          constructor() { super(); this.attachShadow({mode: 'open'}).innerHTML = '<x-a></x-a><p></p>'; }
        });
      </script><body><x-host></x-host><script>log.push('end=1');</script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script('log')).to eq(['xa=1', 'xb=n1', 'end=1'])
  end

  # One constructor two scoped registries define is two definitions, each with the observed attributes it was defined
  # with: the element calls back by its own registry's, not by the definition the constructor was defined with last.
  # Chrome: ["p-x:a=1", "q-x:b=2"].
  it "calls back by the definition of the element's registry" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const log = [];
        class X extends HTMLElement { attributeChangedCallback(n, o, v) { log.push(this.localName + ':' + n + '=' + v); } }
        X.observedAttributes = ['a'];
        const r1 = new CustomElementRegistry(); r1.define('p-x', X);
        X.observedAttributes = ['b'];
        const r2 = new CustomElementRegistry(); r2.define('q-x', X);
        const e1 = document.createElement('p-x', {customElementRegistry: r1});
        const e2 = document.createElement('q-x', {customElementRegistry: r2});
        for (const e of [e1, e2]) { e.setAttribute('a', '1'); e.setAttribute('b', '2'); }
        return log;
      })()
    JS
    expect(got).to eq(['p-x:a=1', 'q-x:b=2'])
  end

  # An element's reactions run one at a time, the rest staying its queue's: a callback's own [CEReactions] call runs them
  # before what it enqueued itself. Chrome: {"typeNested": ["type", "value", "data-x"], "upgradeNested": ["a", "b",
  # "conn", "c"]}.
  it "runs an element's queued reactions before those a callback enqueues" do
    html = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body><x-u a="1" b="2"></x-u><script>
        window.R = {};
        { const log = [];
          class XT extends HTMLInputElement {
            static get observedAttributes() { return ['type', 'value', 'data-x']; }
            attributeChangedCallback(n) { log.push(n); if (n === 'type') this.setAttribute('data-x', '1'); }
          }
          customElements.define('x-t', XT, { extends: 'input' });
          const ti = document.createElement('input', { is: 'x-t' }); document.body.append(ti);
          ti.value = 'vv'; log.length = 0; ti.setAttribute('type', 'checkbox'); R.typeNested = log; }
        { const log = [];
          class XU extends HTMLElement {
            static get observedAttributes() { return ['a', 'b', 'c']; }
            attributeChangedCallback(n) { log.push(n); if (n === 'a') this.setAttribute('c', '3'); }
            connectedCallback() { log.push('conn'); }
          }
          customElements.define('x-u', XU); R.upgradeNested = log; }
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script('R')).to eq('typeNested' => %w[type value data-x], 'upgradeNested' => %w[a b conn c])
  end

  # A frame navigated in the same call as a click that owes its element a reaction on the backup element queue still
  # calls it back: the old document's microtask runs before it goes. Chrome: ["frame-acb"].
  it "calls back a navigated frame's element the backup element queue holds" do
    html = <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body><iframe id="f" srcdoc="<p>frame</p>"></iframe><script>
        window.L = [];
        onload = () => {
          const f = document.getElementById('f'); const w = f.contentWindow;
          class FD extends w.HTMLDetailsElement {
            static get observedAttributes() { return ['open']; }
            attributeChangedCallback() { window.L.push('frame-acb'); }
          }
          w.customElements.define('f-d', FD, { extends: 'details' });
          const fd = w.document.createElement('details', { is: 'f-d' }); fd.innerHTML = '<summary>s</summary>';
          w.document.body.append(fd);
          fd.firstChild.click();
          f.srcdoc = '<p>other</p>';
        };
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script('L')).to eq(['frame-acb'])
  end

  # An upgrade enqueued again — a constructor moving a later element of its own fragment — puts the element on the moving
  # call's element queue, which upgrades it as that call returns, before the constructor goes on: HTML enqueues it again,
  # and an upgrade no longer owed returns at once. Chrome and Firefox: true both, the frame's document the page's too.
  it 'upgrades a later element of a fragment a constructor moves, as the move returns' do
    page = '<!DOCTYPE html><meta charset="utf-8"><body><div id="host"></div><iframe id="f" srcdoc="<!DOCTYPE html><body>"></iframe>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const log = [];
        const frame = document.getElementById('f');
        class XB extends HTMLElement {}
        class XA extends HTMLElement {
          constructor() {
            super();
            const b = document.getElementById('b');
            if (b) { document.body.append(b); log.push(b instanceof XB); }
          }
        }
        customElements.define('x-b', XB);
        customElements.define('x-a', XA);
        document.getElementById('host').innerHTML = '<x-a></x-a><x-b id="b"></x-b>';
        class FB extends frame.contentWindow.HTMLElement {}
        frame.contentWindow.customElements.define('y-b', FB);
        class YB extends HTMLElement {}
        class YA extends HTMLElement {
          constructor() {
            super();
            const b = document.getElementById('yb');
            if (b) { frame.contentDocument.body.append(b); log.push(b instanceof YB); }
          }
        }
        customElements.define('y-b', YB);
        customElements.define('y-a', YA);
        document.getElementById('host').innerHTML = '<y-a></y-a><y-b id="yb"></y-b>';
        return log;
      })()
    JS
    expect(got).to eq([true, true])
  end
end
