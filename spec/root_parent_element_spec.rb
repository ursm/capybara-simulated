# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `<html>` has no parent ELEMENT — its parent is the document — so a child combinator with anything on its left never
# reaches it. The native matcher hung `<html>` under a synthetic document node and walked up to it as though it were
# an element: `* > html` and `:not(.x) > html` matched, in the cascade and in queries alike. Chrome-measured below.
RSpec.describe 'the root element has no parent element' do
  it 'is matched by no child combinator' do
    html = <<~HTML
      <!DOCTYPE html>
      <style>* > html { margin-left: 5px } :not(.x) > html { padding-left: 3px }</style>
      <p id="p">p</p>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const cs = getComputedStyle(document.documentElement);
        return [cs.marginLeft, cs.paddingLeft, document.querySelectorAll('* > html').length,
                document.documentElement.matches(':not(.x) > html'), document.querySelectorAll('html > body > p').length];
      })()
    JS
    expect(got).to eq(['0px', '0px', 0, false, 1])
  end
end
