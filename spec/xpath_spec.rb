# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# document.evaluate is xpath.rs over the arena. What the arena has to carry for it, and what the binding has to hand
# it, beyond what the domxpath WPT tree reaches.
RSpec.describe 'XPath' do
  def session_with(body)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ["<!DOCTYPE html>#{body}"]] })
    s.visit '/'
    s
  end

  # The parser's elements of the page carry no owner document of their own (the getter falls back to `document`): the
  # evaluation is in an HTML document all the same, or no unprefixed name test matches an HTML element.
  it 'evaluates in an HTML document from an element the parser made' do
    s = session_with('<p><span>a</span><span>b</span></p>')
    got = s.evaluate_script(<<~'JS')
      document.evaluate('count(//span)', document.body, null, XPathResult.NUMBER_TYPE, null).numberValue
    JS
    expect(got).to eq(2)
    expect(s.find(:css, 'p').all(:xpath, '//SPAN').size).to eq(2)
  end

  it "answers name() with an element's prefix, and a processing instruction's target" do
    s = session_with('')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const doc = new DOMParser().parseFromString('<r xmlns:p="urn:p"><p:x/><?go now?></r>', 'application/xml');
        const str = (x) => doc.evaluate(x, doc, null, XPathResult.STRING_TYPE, null).stringValue;
        return [str('name(/r/*)'), str('local-name(/r/*)'), str('name(/r/processing-instruction())'), str("string(/r/processing-instruction('go'))")];
      })()
    JS
    expect(got).to eq(['p:x', 'x', 'go', 'now'])
  end

  it 'evaluates from an attribute, whose parent is its element' do
    s = session_with('<div id="d" title="t"></div>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const attr = document.getElementById('d').getAttributeNode('title');
        const r = document.evaluate('..', attr, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return [r.singleNodeValue.id, document.evaluate('string(.)', attr, null, XPathResult.STRING_TYPE, null).stringValue];
      })()
    JS
    expect(got).to eq(['d', 't'])
  end

  it 'finds an attribute node and hands back the Attr the element holds' do
    s = session_with('<div id="d" title="t"></div>')
    got = s.evaluate_script(<<~'JS')
      (() => {
        const el = document.getElementById('d');
        const r = document.evaluate('//@title', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue === el.getAttributeNode('title');
      })()
    JS
    expect(got).to be(true)
  end
end
