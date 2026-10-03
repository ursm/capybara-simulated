# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Constraint validation and "actually disabled" are the arena's (validity.rs, element_state.rs): what `validity`,
# `willValidate` and the `disabled?` query read, and what `:valid`, `:invalid` and `:disabled` match by — one answer,
# where there used to be a JS engine beside the native one.
RSpec.describe 'constraint validation' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body></body>']] } }

  def run(js)
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script("(function () { #{js} })()")
  end

  it 'answers validity with the same live object, and its flags as the value changes' do
    got = run(<<~JS)
      var i = document.createElement('input'); i.required = true; i.pattern = '[a-z]+'; document.body.appendChild(i);
      var v = i.validity, out = [v === i.validity, v.valueMissing, v.valid];
      i.value = 'A1'; out.push(v.valueMissing, v.patternMismatch, v.valid, i.matches(':invalid'));
      i.value = 'ab'; out.push(v.patternMismatch, v.valid, i.matches(':valid'));
      return out;
    JS
    expect(got).to eq([true, true, false, false, true, false, true, false, true, true])
  end

  # Chrome: [false, true, false] — a disabled fieldset disables the controls in its OWN tree; a shadow tree's are not
  # its descendants.
  it 'does not disable a control in a shadow tree under a disabled fieldset' do
    got = run(<<~JS)
      document.body.innerHTML = '<fieldset disabled><div id=h></div></fieldset>';
      var sr = document.getElementById('h').attachShadow({mode: 'open'}); sr.innerHTML = '<input><button>b</button>';
      var i = sr.querySelector('input');
      return [i.matches(':disabled'), i.willValidate, sr.querySelector('button').matches(':disabled')];
    JS
    expect(got).to eq([false, true, false])
  end
end
