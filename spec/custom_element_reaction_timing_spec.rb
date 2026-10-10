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
  it 'calls back an element a shadow tree\'s callback inserts once' do
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
end
