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

  # HTML "statically validate the constraints": the controls that suffer from a constraint are found FIRST, then each is
  # fired `invalid` — so an `invalid` handler that fills in a later control does not save it from its own event, nor the
  # form from failing. Chrome 155 and Firefox both validate each control only as they reach it, and fire none at `b`
  # (`[false, "a"]`); the spec's steps are explicit, and it is them we follow.
  it 'finds the invalid controls before it fires any invalid event' do
    got = run(<<~JS)
      document.body.innerHTML = '<form id=f><input id=a required><input id=b required></form>';
      var log = [], b = document.getElementById('b');
      document.getElementById('a').addEventListener('invalid', function () { log.push('a'); b.value = 'x'; });
      b.addEventListener('invalid', function () { log.push('b'); });
      return [document.getElementById('f').checkValidity(), log.join()];
    JS
    expect(got).to eq([false, 'a,b'])
  end

  # HTML leaves how a problem is reported to the user agent; Chrome 155 and Firefox both focus the control whose
  # `invalid` was not canceled, and neither moves focus for one that was (`[false, "a", false, "z"]`).
  it "reports a control's problem by focusing it" do
    got = run(<<~JS)
      document.body.innerHTML = '<input id=a required><input id=b required><button id=z>z</button>';
      var a = document.getElementById('a'), b = document.getElementById('b'), z = document.getElementById('z'), out = [];
      z.focus(); out.push(a.reportValidity(), document.activeElement.id);
      b.addEventListener('invalid', function (e) { e.preventDefault(); });
      z.focus(); out.push(b.reportValidity(), document.activeElement.id);
      return out;
    JS
    expect(got).to eq([false, 'a', false, 'z'])
  end
end
