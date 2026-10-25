# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The context a fragment is parsed in (HTML's fragment parsing algorithm, DOM Parsing's callers of it): an `<html>`'s
# insertion mode is "before head" — `body.outerHTML = '<body …>'` makes a head and a body — where insertAdjacentHTML and
# createContextualFragment parse an HTML document's `html` as a new `body` of their document, as they do a context that
# is no element, of that document's mode and scripting flag; and a shadow root's markup is parsed in its host's context,
# the form element pointer the host's nearest form (HTML "unsafely set HTML": Chrome — Firefox keeps the inner form).
RSpec.describe 'fragment parsing contexts' do
  let(:session) do
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><form><div id="h"></div></form>']] })
  end

  def trees(script)
    session.evaluate_script(<<~JS)
      (() => {
        const tree = (n) => n.nodeType === 3 ? JSON.stringify(n.data) : n.nodeName.toLowerCase() + '(' + [...n.childNodes].map(tree).join(' ') + ')';
        const all = (nodes) => [...nodes].map(tree).join(' ');
        #{script}
      })()
    JS
  end

  it 'parses an html context before head, and insertAdjacentHTML’s as a body' do
    session.visit '/'
    got = trees(<<~JS)
      const doc = document.implementation.createHTMLDocument('');
      doc.body.outerHTML = '<body id="b"></body>';
      document.documentElement.insertAdjacentHTML('beforeend', '<p>z</p>');
      return [all(doc.documentElement.childNodes), document.getElementsByTagName('body').length];
    JS
    expect(got).to eq(['head(title("")) head() body()', 1])
  end

  it 'parses a range at a document of its own in a new body of that document' do
    session.visit '/'
    got = trees(<<~JS)
      const dp = new DOMParser().parseFromString('<p>q', 'text/html');
      const r = dp.createRange();
      r.setStart(dp, 0);
      return [all(r.createContextualFragment('<p><table>').childNodes), all(r.createContextualFragment('<noscript><b>x</b></noscript>').childNodes)];
    JS
    # (…a quirks document's `<table>` inside the `<p>`, and a scripting-disabled one's `<noscript>` content markup)
    expect(got).to eq(['p(table())', 'noscript(b("x"))'])
  end

  it 'parses a shadow root’s markup in its host’s context' do
    session.visit '/'
    got = trees(<<~JS)
      const sr = document.getElementById('h').attachShadow({mode: 'open'});
      sr.innerHTML = '<form><input></form>';
      const inner = all(sr.childNodes);
      sr.setHTMLUnsafe('<form><input></form>');
      return [inner, all(sr.childNodes)];
    JS
    expect(got).to eq(['input()', 'input()'])
  end

  # …and a fragment's elements take its context's registry: a body made for a range its document's (HTML "create an
  # element": Chrome), an inert document's none — insertAdjacentHTML's the node it was asked of (Chrome, WPT
  # custom-elements/registries, whatwg/html#10854).
  it 'gives a fragment its context’s registry' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        customElements.define('x-up', class extends HTMLElement {});
        const reg = new CustomElementRegistry();
        reg.define('x-up', class extends HTMLElement {});
        const who = (n) => n.customElementRegistry === null ? 'null' : n.customElementRegistry === reg ? 'scoped' : 'global';
        const sr = document.getElementById('h').attachShadow({mode: 'open', customElementRegistry: reg});
        sr.append('t');
        const at = (node) => { const r = document.createRange(); r.setStart(node, 0); return who(r.createContextualFragment('<x-up></x-up>').firstChild); };
        const t = document.createElement('template');
        sr.firstChild.after(document.createElement('i'));
        sr.lastChild.insertAdjacentHTML('afterend', '<x-up></x-up>');
        return [at(sr), at(sr.firstChild), at(t.content), who(sr.lastChild)];
      })()
    JS
    expect(got).to eq(%w[global global null scoped])
  end
end
