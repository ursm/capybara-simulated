require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML §8.6 timer initialization steps 5-7 (timers.rs `timerAdd`): a timer scheduled in a timer task whose nesting
# level is past 5, with a timeout under 4 ms, falls due in 4. A chain of `setTimeout(f, 0)` runs its first six one
# after another at once and every later one 4 ms after the last; an interval of 0 likewise from its seventh run.
RSpec.describe 'the timer nesting clamp' do
  it 'clamps a timer nested more than five deep to 4 ms' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const chain = [], ticks = [];
      const t0 = performance.now();
      const step = () => { chain.push(performance.now() - t0); if (chain.length < 9) setTimeout(step, 0); };
      setTimeout(step, 0);
      const i0 = performance.now();
      const id = setInterval(() => { ticks.push(performance.now() - i0); if (ticks.length === 9) clearInterval(id); }, 0);
      setTimeout(() => done({ chain, ticks }), 200);
    JS
    # (…the gaps as the clamp has them — under 4 ms for the first five, at least 4 for the rest, and well under 8, a clamp
    # and no coarser step: the clock follows the wall a little on a loaded machine, so a clamped gap may measure 5, an
    # unclamped one 1)
    clamped = ->(times) { times.each_cons(2).map {|a, b| (b - a) >= 4 && (b - a) < 8 } }
    expect(clamped.(got['chain'])).to eq([false] * 5 + [true] * 3)
    expect(clamped.(got['ticks'])).to eq([false] * 5 + [true] * 3)
  end

  # A repeating timer is scheduled again once its handler has run (the timer task's step 7), after every timer made
  # before then: an interval of 0 and a timeout of 0 made after it take turns. Chrome 155: `f, g, f, f`.
  it 'schedules an interval again after the timers made before its run' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8">']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [];
      let n = 0;
      const id = setInterval(() => { log.push('f'); if (++n === 3) clearInterval(id); }, 0);
      setTimeout(() => log.push('g'), 0);
      setTimeout(() => done(log), 50);
    JS
    expect(got).to eq(%w[f g f f])
  end
end
