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
    # (…the gaps as the clamp has them — under 4 ms for the first five, 4 for the rest: the virtual clock may move a
    # little between tasks of a loaded machine, never past a clamp's 4 ms by a whole one)
    clamped = ->(times) { times.each_cons(2).map {|a, b| (b - a) >= 4 && (b - a) < 5 } }
    expect(clamped.(got['chain'])).to eq([false] * 5 + [true] * 3)
    expect(clamped.(got['ticks'])).to eq([false] * 5 + [true] * 3)
  end
end
