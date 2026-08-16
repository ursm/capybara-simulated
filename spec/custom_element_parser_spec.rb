# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# HTML's "create an element for the token": the parser constructs a custom
# element SYNCHRONOUSLY when a definition exists — before its attributes are
# set and its children appended. The WPT custom-elements/parser cluster covers
# the contract itself; these specs pin the two INERT cases the WPT corpus does
# NOT cover, both of which regressed silently while the whole gate stayed
# green: `<template>` contents (parsed into the inert template document) and a
# null-registry subtree (the `customelementregistry` attribute).
RSpec.describe 'HTML parser custom-element construction' do
  def page(body)
    <<~HTML
      <html><body>
      <script>
        window.__ctors = [];
        class MyEl extends HTMLElement {
          constructor() { super(); window.__ctors.push(this.localName); }
        }
        customElements.define('my-el', MyEl);
      </script>
      #{body}
      </body></html>
    HTML
  end

  def session_for(body)
    html = page(body)
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  it 'constructs a defined custom element while parsing, before attributes and children' do
    s = session_for('<my-el id="plain" data-x="1">text</my-el>')

    expect(s.evaluate_script('window.__ctors')).to eq(['my-el'])
    expect(s.evaluate_script("document.getElementById('plain') instanceof customElements.get('my-el')")).to be true
  end

  # Template contents belong to the associated inert template document, which
  # has no registry — a real browser runs no constructor for them.
  it 'does not construct custom elements inside template contents' do
    s = session_for('<template id="t"><my-el a="1"></my-el></template>')

    expect(s.evaluate_script('window.__ctors')).to eq([])
    expect(s.evaluate_script("document.getElementById('t').content.firstElementChild instanceof customElements.get('my-el')")).to be false
  end

  # The `customelementregistry` content attribute marks a subtree null-registry:
  # no definition resolves there, so the parser must not construct either.
  it 'does not construct custom elements under a null-registry subtree' do
    s = session_for('<div customelementregistry><my-el id="scoped"></my-el></div>')

    expect(s.evaluate_script('window.__ctors')).to eq([])
    expect(s.evaluate_script("document.getElementById('scoped') instanceof customElements.get('my-el')")).to be false
  end

  # A constructor that throws leaves the element in custom element state
  # "failed": it implements HTMLUnknownElement and never upgrades later.
  it 'falls back to HTMLUnknownElement when the constructor throws, and never upgrades it' do
    html = <<~HTML
      <html><body>
      <script>
        class BadEl extends HTMLElement { constructor() { super(); throw new Error('nope'); } }
        customElements.define('bad-el', BadEl);
      </script>
      <bad-el id="bad"></bad-el>
      </body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'

    expect(s.evaluate_script("document.getElementById('bad') instanceof HTMLUnknownElement")).to be true
    expect(s.evaluate_script("document.getElementById('bad') instanceof customElements.get('bad-el')")).to be false
    # customElements.upgrade() must not resurrect a failed element.
    s.execute_script("customElements.upgrade(document.getElementById('bad'));")
    expect(s.evaluate_script("document.getElementById('bad') instanceof customElements.get('bad-el')")).to be false
  end

  # An UNDEFINED valid custom element name implements HTMLElement, not
  # HTMLUnknownElement (DOM "create an element"); a genuinely unknown tag does.
  it 'gives an undefined custom-element name the HTMLElement interface' do
    s = session_for('<never-defined id="u"></never-defined><foo id="f"></foo>')

    expect(s.evaluate_script("document.getElementById('u') instanceof HTMLUnknownElement")).to be false
    expect(s.evaluate_script("document.getElementById('u') instanceof HTMLElement")).to be true
    expect(s.evaluate_script("document.getElementById('f') instanceof HTMLUnknownElement")).to be true
  end
end
