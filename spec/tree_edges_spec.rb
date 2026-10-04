# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A parent's children are written in one place (tree.js), which empties a parent in place: `childNodes` is the same live
# list for the node's whole life ([SameObject]), so one a script holds sees what replacing all the children leaves —
# `textContent`, `innerHTML` (a template's content's and a fragment's too) and `replaceChildren` alike — where it used to
# be orphaned with the old children in it. Chrome: true for each.
RSpec.describe 'tree edges' do
  it 'keeps childNodes the same live list across replacing all the children' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><div id=d><b>1</b><i>2</i></div>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        const kids = d.childNodes;
        const out = [];
        d.textContent = 'x';
        out.push(kids === d.childNodes && kids.length === 1 && kids[0].data === 'x');
        d.innerHTML = '<p>a</p><p>b</p>';
        out.push(kids === d.childNodes && kids.length === 2);
        d.replaceChildren(document.createElement('span'));
        out.push(kids === d.childNodes && kids.length === 1 && kids[0].localName === 'span');
        const t = document.createElement('template');
        const content = t.content.childNodes;
        t.innerHTML = '<b>1</b>';
        t.innerHTML = '<i>2</i><i>3</i>';
        out.push(content === t.content.childNodes && content.length === 2);
        const f = document.createDocumentFragment();
        f.appendChild(document.createElement('u'));
        const frag = f.childNodes;
        document.body.attachShadow({mode: 'open'}).innerHTML = '<p>s</p>';
        const shadow = document.body.shadowRoot.childNodes;
        document.body.shadowRoot.innerHTML = '<a></a><a></a><a></a>';
        out.push(shadow === document.body.shadowRoot.childNodes && shadow.length === 3, frag === f.childNodes);
        return out;
      })()
    JS
    expect(got).to eq([true] * 6)
  end

  # A custom element reaction walk collects the elements first: a `disconnectedCallback` that replaces the children of the
  # element being removed does not send the walk into the new ones — b and c are told they left, n1-n3 never were in.
  # Chrome: a+, b+, c+, |, a-, b-, c-.
  it 'tells every removed custom element it was disconnected, whatever a callback replaces' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const log = [];
        const w = document.createElement('div');
        customElements.define('x-h', class extends HTMLElement {
          connectedCallback() { log.push(this.id + '+'); }
          disconnectedCallback() {
            log.push(this.id + '-');
            if (this.id === 'a') w.innerHTML = '<x-h id=n1></x-h><x-h id=n2></x-h><x-h id=n3></x-h>';
          }
        });
        w.innerHTML = '<x-h id=a></x-h><x-h id=b></x-h><x-h id=c></x-h>';
        document.body.appendChild(w);
        log.push('|');
        w.remove();
        return log;
      })()
    JS
    expect(got).to eq(%w[a+ b+ c+ | a- b- c-])
  end
end
