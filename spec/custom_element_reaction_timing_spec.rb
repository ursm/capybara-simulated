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
end
