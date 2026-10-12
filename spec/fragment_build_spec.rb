# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A fragment parse — `innerHTML`, `insertAdjacentHTML`, a contextual fragment — is built by the engine (html_parse.rs
# `htmlParseFragment`), the bindings' own steps run after for the elements that have them: an event handler attribute,
# a namespaced attribute's names, a select's options, a template's inert contents, a script's "already started" — and
# no form a table foster-parented it out of is its owner once inserted. Every expectation is Chrome's.
RSpec.describe 'fragment build' do
  it 'builds what the bindings would have' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><div id=h></div>']] }).tap {|session| session.visit '/' }
    got = s.evaluate_script(<<~'JS')
      (() => {
        const h = document.getElementById('h');
        h.innerHTML = '<button onclick="window.hit = 1">b</button>' +
          '<svg><a xlink:href="#x"><text>t</text></a></svg>' +
          '<select><option>1<option selected>2</select>' +
          '<table><form id=f></form><tr><td><input id=i></td></tr></table>' +
          '<template><p>in</p><script>window.ran = 1</script></template>' +
          '<script>window.ran = 2</script>';
        h.querySelector('button').click();
        const a = h.querySelector('a'), t = h.querySelector('template');
        document.body.appendChild(h.querySelector('script').cloneNode(true));
        return [
          window.hit, a.attributes[0].namespaceURI, a.attributes[0].localName, a.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
          h.querySelector('select').selectedIndex, document.getElementById('i').form && document.getElementById('i').form.id,
          t.content.firstChild.ownerDocument !== document, t.content.firstChild.ownerDocument === t.content.ownerDocument,
          window.ran === undefined
        ];
      })()
    JS
    expect(got).to eq([1, 'http://www.w3.org/1999/xlink', 'href', '#x', 1, nil, true, true, true])
  end

  # What no later insertion runs the steps for — a parsed document's tree, a template's contents — has the engine's
  # insertion steps run over it: a radio group's last checked button is the one left checked (Chrome).
  it "runs the radio groups' steps over a parsed document and a template's contents" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><div id=d></div>']] }).tap {|session| session.visit '/' }
    got = s.evaluate_script(<<~'JS')
      (() => {
        const radios = '<form><input type=radio name=r checked><input type=radio name=r checked></form>';
        const doc = new DOMParser().parseFromString(radios, 'text/html');
        const d = document.getElementById('d');
        d.innerHTML = '<template>' + radios + '</template>';
        const checked = (root) => [...root.querySelectorAll('input')].map((r) => r.checked);
        return [checked(doc), checked(d.firstChild.content)];
      })()
    JS
    expect(got).to eq([[false, true], [false, true]])
  end
end
