# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# Reflected element references (element_references.rs): what the IDL attribute sets is held for the content attribute
# in no namespace. Every expectation is Chrome's.
RSpec.describe 'reflected element references' do
  # An attribute of the same name in another namespace is another attribute: the setter adds the one in none beside it
  # (where it wrote that one, the getter, reading the one in none, answered null), and the elements it holds are those
  # still valid — none, `b` being in no tree of `a`'s.
  it 'sets the content attribute in no namespace' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~JS)).to eq([0, 'q', 'q'])
      (() => {
        const a = document.createElement('div'), b = document.createElement('div');
        document.body.append(a);
        a.setAttributeNS('http://x', 'aria-labelledby', 'q');
        a.ariaLabelledByElements = [b];
        return [a.ariaLabelledByElements.length, a.getAttributeNS('http://x', 'aria-labelledby'), a.getAttribute('aria-labelledby')];
      })()
    JS
  end
end
