# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A selector's pseudo-classes are read off its TEXT to classify the rule (dynamic, `:has()`), and a CSS escape stands
# for its character: `:h\61s(> i)` is `:has(> i)` to every matcher, so it must be one to the classification too — a
# `:has()` rule that the cache takes for a static one serves the answer from before its subject gained the child.
# An escaped SYNTAX character stays part of an identifier: `.hover\:w` is one class. Chrome-measured.
RSpec.describe 'escaped pseudo-classes' do
  it 'classifies an escaped :has() as one, and an escaped colon as none' do
    html = <<~'HTML'
      <!DOCTYPE html>
      <style>.p { width: 40px } .p:h\61s(> i) { width: 41px } .hover\:w { width: 7px }</style>
      <div class="p" id="p"></div><div class="hover:w" id="t"></div>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p'), w = () => getComputedStyle(p).width, r = [w()];
        p.appendChild(document.createElement('i')); r.push(w());
        p.firstChild.remove(); r.push(w());
        r.push(getComputedStyle(document.getElementById('t')).width);
        return r;
      })()
    JS
    expect(got).to eq(%w[40px 41px 40px 7px])
  end
end
