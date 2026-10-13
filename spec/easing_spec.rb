# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An effect's easing as Web Animations reads it back, the engine's (easing.rs): a `calc()` in an easing function is a
# number like any other, the default step position is left out however it is written, and a page's numbers keep the
# double precision it wrote them in. Chrome 155: each figure below.
RSpec.describe 'Easing functions' do
  it 'reads back calc(), jump-end and doubles as Chrome does' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }).tap {|session| session.visit '/' }
    expect(s.evaluate_script(<<~'JS')).to eq(['steps(2)', 'cubic-bezier(0.1, 0, 1, 1)', 'linear(0 0%, 0.5 25%, 1 100%)', 'steps(2)', 'cubic-bezier(0.3333333333, 0, 1, 1)', 'TypeError'])
      (() => {
        const read = (easing) => new KeyframeEffect(null, null, { easing }).getTiming().easing;
        const out = ['steps(calc(2))', 'cubic-bezier(calc(0.1), 0, 1, 1)', 'linear(0, calc(0.5) 25%, 1)', 'steps(2, jump-end)', 'cubic-bezier(0.3333333333, 0, 1, 1)'].map(read);
        try { read('steps(1, jump-none)'); } catch (e) { out.push(e.name); }
        return out;
      })()
    JS
  end
end
