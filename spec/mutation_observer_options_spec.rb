# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# MutationObserver's "observe" validates its options whatever it observes (DOM steps 1-6, mutation_observers.rs
# `observe_options`): an Attr — a node of no tree the engine keeps — is refused options that ask for nothing as an
# element is, and registers nothing.
RSpec.describe 'MutationObserver options' do
  it 'are refused for an Attr as for an element' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const attempt = (target, options) => { try { new MutationObserver(() => {}).observe(target, options); return 'ok'; } catch (e) { return e.name; } };
        const attr = document.createAttribute('x');
        return [attempt(attr, {}), attempt(attr, { attributes: false, attributeOldValue: true }), attempt(attr, { attributes: true }), attempt(document.body, {})];
      })()
    JS
    expect(got).to eq(%w[TypeError TypeError ok TypeError])
  end
end
