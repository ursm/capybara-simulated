# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A DOMTokenList's set and the element lists named by a filter are the engine's (token_list.rs, collections.rs). Each
# expectation below is Chrome's.
RSpec.describe 'token lists and filtered element lists' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/' }

  def run(js) = session.evaluate_script("(() => { #{js} })()")

  it 'holds no empty token, and writes the attribute in no namespace' do
    got = run(<<~JS)
      const e = document.createElement('div');
      e.setAttribute('class', 'a  b');
      const empty = e.classList.contains('');
      const n = document.createElement('div');
      n.setAttributeNS('urn:x', 'class', 'nsv');
      n.classList.add('b');
      n.classList.value = null;
      return [empty, n.getAttribute('class'), n.getAttributeNS('urn:x', 'class'), n.getAttributeNS(null, 'class'), n.attributes.length];
    JS
    expect(got).to eq([false, 'nsv', 'nsv', 'null', 2])
  end

  it "matches a document's own element by the qualified-name rule, and a lone surrogate exactly" do
    got = run(<<~JS)
      const xml = new DOMParser().parseFromString('<Root><a/><A/></Root>', 'application/xml');
      const f = document.createElement('div');
      f.append(document.createElementNS('urn:x', 'a\\ud800'), document.createElementNS('urn:x', 'a\\ufffd'), document.createElementNS('urn:\\ud800', 'z'));
      return [xml.getElementsByTagName('root').length, xml.getElementsByTagName('Root').length,
              f.getElementsByTagName('a\\ud800').length, f.getElementsByTagNameNS('urn:\\ufffd', 'z').length,
              typeof document.createDocumentFragment().getElementsByTagName];
    JS
    expect(got).to eq([0, 1, 1, 0, 'undefined'])
  end
end
