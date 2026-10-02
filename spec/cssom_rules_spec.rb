# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a CSSOM rule says is what the style engine reads of it (cssom_rule.rs): a style rule's selector is the list the
# engine parses and serializes, an `@namespace` rule's prefix the identifier it reads, an `@counter-style` rule's
# descriptors the ones it keeps. Every expectation is Chrome 151's on the same markup, unless it says otherwise.
RSpec.describe 'CSSOM rules' do
  def page(css)
    html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>#{css}</style></head><body></body></html>"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  # A selector the engine does not parse leaves the rule as it was; one it does is written as it serializes it — the
  # legacy pseudo-elements with two colons, an An+B canonical, a prefix of the sheet's `@namespace` (escaped as it was
  # declared) kept, an undeclared one refused.
  it 'takes a selector as the engine parses it' do
    got = page('@namespace ns\:odd url(ns); .a { color: red }').evaluate_script(<<~JS)
      (() => {
        const rule = document.styleSheets[0].cssRules[1];
        return [':first-line', 'p::FIRST-LETTER', ':gibberish', 'ns\\\\:odd|p', 'x|p', ':nth-child( odd )'].map((s) => {
          rule.selectorText = s;
          const text = rule.selectorText;
          rule.selectorText = '.a';
          return text;
        });
      })()
    JS
    expect(got).to eq(['::first-line', 'p::first-letter', '.a', 'ns\:odd|p', '.a', ':nth-child(2n+1)'])
  end

  it 'reads an @namespace prefix as an identifier' do
    got = page('@namespace ns\:odd url(ns);').evaluate_script(<<~JS)
      (() => { const rule = document.styleSheets[0].cssRules[0]; return [rule.prefix, rule.namespaceURI, rule.cssText]; })()
    JS
    expect(got).to eq(['ns:odd', 'ns', '@namespace ns\:odd url("ns");'])
  end

  # Each descriptor is an attribute, and `cssText` holds them all (Chrome orders them `system; symbols; suffix`, the
  # engine as Gecko does — the order is not specified). A write the engine refuses changes nothing: a value that does
  # not parse, another KIND of system (even one the symbols would allow), a name no counter style can have.
  it "keeps an @counter-style rule's descriptors, and refuses the writes the engine refuses" do
    got = page('@counter-style foo { system: cyclic; symbols: "*"; suffix: " " }').evaluate_script(<<~JS)
      (() => {
        const rule = document.styleSheets[0].cssRules[0];
        const out = [rule.cssText, rule.system, rule.symbols, rule.suffix, rule.prefix];
        rule.system = 'bogus';
        rule.symbols = '"a" "b"';
        rule.system = 'numeric';
        rule.name = 'none';
        rule.name = 'bar';
        return out.concat([rule.system, rule.symbols, rule.name, rule.cssText]);
      })()
    JS
    expect(got).to eq([
      '@counter-style foo { system: cyclic; suffix: " "; symbols: "*"; }', 'cyclic', '"*"', '" "', '',
      'cyclic', '"a" "b"', 'bar', '@counter-style bar { system: cyclic; suffix: " "; symbols: "a" "b"; }'
    ])
  end
end
