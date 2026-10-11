# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A realm's animation frame callbacks are the engine's (timers.rs `frames`): a frame runs those requested before it
# began, in order — one requested by a callback of it in the next frame, and one an earlier callback of it cancelled not
# at all (HTML "run the animation frame callbacks").
RSpec.describe 'animation frame callbacks' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  it 'runs a frame\'s callbacks in order, passing by one cancelled during it' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      let b;
      requestAnimationFrame(() => {
        log.push('a');
        cancelAnimationFrame(b);
        requestAnimationFrame(() => log.push('next'));
      });
      b = requestAnimationFrame(() => log.push('b'));
      const c = requestAnimationFrame(() => log.push('c'));
      requestAnimationFrame(() => { log.push('d'); cancelAnimationFrame(c); });
    JS
    3.times { session.execute_script('__drainTimers(20)') }
    expect(session.evaluate_script('log')).to eq(%w[a c d next])
  end
end
