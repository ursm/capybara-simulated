# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `element.animate()` and the `Animation` it returns — the same value model CSS animations use,
# reached through script. The timing model's whole content is two numbers: a START TIME (the moment
# the animation's own time was zero) while it runs, and a HOLD TIME (its own time, held still) while
# it is paused, idle or finished; every method is a rule for moving a value between the two.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'Web Animations' do
  def page(markup = '<div id="a"></div>')
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head>
             <body style="margin:0;font:16px Arial">#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  it 'reports the value the animation has reached' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq(['50px', 'running', 500])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate({ blockSize: ['0px', '100px'] }, 1000);
        anim.currentTime = 500;
        return [getComputedStyle(div).height, anim.playState, anim.currentTime];
      })()
    JS
  end

  # A keyframe may name a FLOW-RELATIVE property, which is the same value as its physical twin — so
  # the layout engine, which reads the physical name, sees it.
  it 'animates a logical property through its physical twin' do
    s = page('<div id="a" style="width:0;height:0"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['0px', '50px'])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate({ blockSize: ['0px', '100px'] }, 1000);
        anim.currentTime = 500;
        return [getComputedStyle(div).width, getComputedStyle(div).height];
      })()
    JS
  end

  # `pause()` holds the animation where it is; `finish()` sends it to its end AND resolves the start
  # time, which is what makes it finished rather than paused; and with no fill it then applies
  # nothing at all.
  it 'moves between paused, finished and idle' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq(['paused', '50px', 'finished', '0px', 'idle', '0px'])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate({ blockSize: ['0px', '100px'] }, 1000);
        anim.currentTime = 500;
        anim.pause();
        const out = [anim.playState, getComputedStyle(div).height];
        anim.finish();
        out.push(anim.playState, getComputedStyle(div).height);
        anim.cancel();
        out.push(anim.playState, getComputedStyle(div).height);
        return out;
      })()
    JS
  end

  # …and one that FILLS FORWARDS holds its last keyframe after it ends.
  it 'holds the last keyframe when it fills forwards' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq(['1', '4'])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate([{ flexGrow: 0 }, { flexGrow: 4 }], { duration: 100000, fill: 'forwards' });
        anim.pause();
        anim.currentTime = 25000;
        const at = getComputedStyle(div).flexGrow;
        anim.finish();
        return [at, getComputedStyle(div).flexGrow];
      })()
    JS
  end

  # `alternate` turns every odd iteration around, so 1500ms into 1000ms iterations is the second one
  # a quarter through — which reversed is three quarters.
  it 'runs iterations in the direction the timing asks for' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq(['50px', '75px'])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate({ blockSize: ['0px', '100px'] },
                                 { duration: 1000, iterations: 3, direction: 'alternate' });
        anim.pause();
        anim.currentTime = 1500;
        const half = getComputedStyle(div).height;
        anim.currentTime = 1250;
        return [half, getComputedStyle(div).height];
      })()
    JS
  end

  # Keyframes with no offsets are spaced evenly; a property given ONE value is a to-keyframe, which
  # animates from whatever the element already has.
  it 'computes the missing keyframe offsets' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq([[0, 0.5, 1], [[1, '300px']]])
      (function () {
        const div = document.getElementById('a');
        const even = div.animate([{ opacity: 0 }, { opacity: 0.5 }, { opacity: 1 }], 100);
        const single = div.animate({ blockSize: '300px' }, 100);
        return [even.effect.getKeyframes().map((k) => k.computedOffset),
                single.effect.getKeyframes().map((k) => [k.computedOffset, k.blockSize])];
      })()
    JS
  end

  # A property that cannot be animated at all is dropped when the keyframes are processed — which is
  # a different thing from one whose values can't be interpolated: that one flips discretely.
  it 'drops a property that is not animatable' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq(['horizontal-tb', 0])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate({ writingMode: 'vertical-rl' }, { duration: 1, easing: 'step-start' });
        return [getComputedStyle(div).writingMode, anim.effect.getKeyframes().length];
      })()
    JS
  end

  it 'reports its computed timing' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq([0.25, 1, 1000, 3000])
      (function () {
        const anim = document.getElementById('a').animate({ opacity: [0, 1] },
                       { duration: 1000, iterations: 3, direction: 'alternate' });
        anim.pause();
        anim.currentTime = 1750;
        const t = anim.effect.getComputedTiming();
        return [t.progress, t.currentIteration, t.duration, t.activeDuration];
      })()
    JS
  end

  # `getAnimations()` reports the element's own, in the order they were created — which is also the
  # order they are applied in, so a later one wins a property they share.
  it 'lists the animations on an element in composite order' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq([2, '3'])
      (function () {
        const div = document.getElementById('a');
        const first = div.animate([{ flexGrow: 0 }, { flexGrow: 4 }], { duration: 1000, fill: 'both' });
        const second = div.animate([{ flexGrow: 3 }, { flexGrow: 3 }], { duration: 1000, fill: 'both' });
        first.pause(); second.pause();
        first.currentTime = 500; second.currentTime = 500;
        return [div.getAnimations().length, getComputedStyle(div).flexGrow];
      })()
    JS
  end

  # The API surface itself: a page feature-probes these constructors before using `animate()`, and
  # `document.getAnimations()` used to answer for the document NODE as an animation target — always
  # an empty list, which is a probe-passing lie rather than an absence.
  it 'exposes the Web Animations interfaces' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq([%w[function function function function function], true, true, true, [0, 1]])
      (function () {
        const div = document.getElementById('a');
        const types = [typeof Animation, typeof KeyframeEffect, typeof AnimationEffect,
                       typeof DocumentTimeline, typeof AnimationPlaybackEvent];
        const before = document.getAnimations().length;
        const anim = div.animate([{ opacity: 0 }, { opacity: 1 }], 1000);
        return [types, anim instanceof Animation, anim instanceof EventTarget,
                anim.effect instanceof KeyframeEffect, [before, document.getAnimations().length]];
      })()
    JS
  end

  # `cancel(); play()` is how a page restarts an animation — the cancelled one has to come back.
  it 'plays again after being cancelled' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq(['idle', false, 'paused', '5', true])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate([{ flexGrow: 0 }, { flexGrow: 10 }], { duration: 1000, fill: 'both' });
        anim.cancel();
        const out = [anim.playState, div.getAnimations().includes(anim)];
        anim.play();
        anim.pause();
        anim.currentTime = 500;
        out.push(anim.playState, getComputedStyle(div).flexGrow, div.getAnimations().includes(anim));
        return out;
      })()
    JS
  end

  # An effect that targets a PSEUDO-ELEMENT does not animate the element: a page fading its
  # `::before` must not fade the element itself, or nothing on the page can be seen any more.
  it 'keeps a pseudo-element animation off the element' do
    s = page('<style>#a::before { content: "x"; display: block }</style><div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['::before', '1', 0])
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate({ opacity: [1, 0] }, { duration: 1000, pseudoElement: '::before' });
        anim.pause();
        anim.currentTime = 1000;
        return [anim.effect.pseudoElement, getComputedStyle(div).opacity, div.getAnimations().length];
      })()
    JS
  end

  # `composite: 'add'` composes with the value underneath instead of replacing it.
  it 'adds to the underlying value under composite: add' do
    s = page('<div id="a" style="flex-grow:5"></div>')
    expect(s.evaluate_script(<<~JS)).to eq('7')
      (function () {
        const div = document.getElementById('a');
        const anim = div.animate([{ flexGrow: 1 }, { flexGrow: 3 }], { duration: 1000, composite: 'add' });
        anim.pause();
        anim.currentTime = 500;
        return getComputedStyle(div).flexGrow;
      })()
    JS
  end

  # In the object form each property's values are spread over the WHOLE animation on their own, so
  # three opacities and two flex-grows put the flex-grows at 0 and 1 — not at 0 and a half. And a
  # shorthand is reported as the shorthand it was written as, however many longhands it drives.
  it 'spaces each property over its own offsets' do
    s = page
    expect(s.evaluate_script(<<~JS)).to eq([[[0, '0', '1'], [0.5, '0.5', nil], [1, '1', '2']], ['margin'], '5px'])
      (function () {
        const div = document.getElementById('a');
        const mixed = div.animate({ opacity: [0, 0.5, 1], flexGrow: ['1', '2'] }, 1000);
        const shorthand = div.animate({ margin: ['0px', '10px'] }, 1000);
        shorthand.pause();
        shorthand.currentTime = 500;
        const keys = Object.keys(shorthand.effect.getKeyframes()[0])
                           .filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
        return [mixed.effect.getKeyframes().map((k) => [k.computedOffset, k.opacity ?? null, k.flexGrow ?? null]),
                keys, getComputedStyle(div).marginLeft];
      })()
    JS
  end

  # The `finished` promise is how a page waits for an animation, and the commonest way one finishes
  # is neither `finish()` nor a seek — the clock simply carries it past its end.
  it 'settles the finished promise when the clock runs out' do
    s = page
    s.execute_script(<<~JS)
      window.log = [];
      setInterval(() => {}, 1000);          // the page has work, so the clock steps
      const div = document.getElementById('a');
      const anim = div.animate([{ flexGrow: 0 }, { flexGrow: 10 }], 300);
      anim.onfinish = (e) => log.push('event:' + e.constructor.name + ':' + (e.timelineTime != null));
      anim.finished.then(() => log.push('promise:' + anim.playState));
      const other = div.animate([{ opacity: 0 }, { opacity: 1 }], 100000);
      other.finished.catch((err) => log.push('rejected:' + err.name));
      window.other = other;
    JS
    5.times { s.evaluate_script('1') }
    s.execute_script('other.cancel()')
    3.times { s.evaluate_script('1') }
    expect(s.evaluate_script('log')).to eq(['promise:finished', 'event:AnimationPlaybackEvent:true',
                                            'rejected:AbortError'])
  end

  # The timeline is the driver's own clock — the same one CSS animations advance on and
  # `requestAnimationFrame` is handed — so a script animation and an `@keyframes` stay in step, and
  # a running animation moves as the event loop steps.
  it 'advances on the driver clock' do
    s = page
    s.execute_script(<<~JS)
      setInterval(() => {}, 1000);          // the page has work, so the clock steps
      window.anim = document.getElementById('a').animate([{ flexGrow: 0 }, { flexGrow: 10 }],
                                                         { duration: 1000, fill: 'both' });
    JS
    seen = Array.new(4) { s.evaluate_script("getComputedStyle(document.getElementById('a')).flexGrow").to_f }
    expect(seen.uniq.size).to be > 1
    expect(seen).to eq(seen.sort)
    expect(seen.last).to be <= 10
  end
end
