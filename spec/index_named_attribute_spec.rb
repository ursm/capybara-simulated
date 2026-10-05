# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element's attributes are the arena's, read through an interceptor object (`__dom.attrsView`). An attribute named
# like an array index — `2`, `0` — is a key V8 hands an object's INDEXED handler, not its named one: with only the named
# one, a parsed `2` read as absent and a set `0` landed on the object, outside the attributes. Each expectation below is
# Chrome's.
RSpec.describe 'an attribute named like an array index' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><div id=d 2=a b=c 1=d></div>']] }) }

  before { session.visit '/' }

  it 'is an attribute like any other, in its place in the list' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        d.setAttribute('0', 'z');
        const read = [d.getAttribute('2'), d.hasAttribute('1'), d.getAttributeNames().join()];
        d.removeAttribute('2');
        return [...read, d.outerHTML, d.matches('[\\\\30="z"]'), d.getAttributeNode('1').compareDocumentPosition(d.getAttributeNode('b'))];
      })()
    JS
    expect(got).to eq(['a', true, 'id,2,b,1,0', '<div id="d" b="c" 1="d" 0="z"></div>', true, 34])
  end
end
