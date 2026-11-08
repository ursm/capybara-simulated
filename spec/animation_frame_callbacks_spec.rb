# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/engine_global'

# A realm's animation frame callbacks are the engine's (timers.rs `frames`): a frame runs those requested before it
# began, in order — one requested by a callback of it in the next frame, and one an earlier callback of it cancelled not
# at all (HTML "run the animation frame callbacks").
RSpec.describe 'animation frame callbacks', engine_global: true do
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
    3.times { session.execute_script('RustyRacer.steps.drainTimers(20)') }
    expect(session.evaluate_script('log')).to eq(%w[a c d next])
  end

  # HTML's event loop takes a rendering opportunity between tasks: a step whose budget reaches a timer due later runs the
  # frame a task asked for first — an animation frame callback, and a callback that frame's own callbacks ask for a
  # frame's interval on — never the later timer ahead of it, as one step with a single rendering update at its end did.
  it 'runs the frames owed before a timer due later in the same step' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.log = [];
      const t0 = performance.now();
      setTimeout(() => log.push('timer'), 50);
      requestAnimationFrame(() => {
        log.push('frame');
        requestAnimationFrame((t) => log.push('next frame ' + (t - t0 < 50)));
      });
      RustyRacer.steps.drainTimers(100);
    JS
    expect(session.evaluate_script('log')).to eq(['frame', 'next frame true', 'timer'])
  end

  # …and what a rendering update's callbacks queue is the next step's to run: a read after the step that ran the frame
  # sees the frame's work, and not yet the task it queued — a lazy frame its intersection observations began fetching
  # is answered after it, as a network's answer would be (Avo's has_one tab group read before its embedded frame loads).
  it 'leaves the tasks a frame queued to the step after it' do
    session.visit '/'
    seen = session.evaluate_script(<<~JS)
      (() => {
        requestAnimationFrame(() => {
          document.body.append(Object.assign(document.createElement('p'), { id: 'frame' }));
          setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { id: 'task' })), 0);
        });
        const seen = (id) => !!document.getElementById(id);
        RustyRacer.steps.drainTimers(50);
        const once = [seen('frame'), seen('task')];
        RustyRacer.steps.drainTimers(50);
        return [...once, seen('task')];
      })()
    JS
    expect(seen).to eq([true, false, true])
  end

  # …at most one a frame's interval, whatever a frame queues: a loop of animation frame callbacks each queuing a 1 ms
  # timer ran its frames 1 ms apart and starved a later timer of the page's.
  it 'runs a later timer under an animation frame loop that queues a timer every frame' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.frames_run = 0;
      (function frame() { frames_run++; setTimeout(() => {}, 1); requestAnimationFrame(frame); })();
      setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { id: 'done' })), 3000);
    JS
    expect(session).to have_css('#done', visible: :all, wait: 5)
    expect(session.evaluate_script('frames_run')).to be <= 190
  end
end
