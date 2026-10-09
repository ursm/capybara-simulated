# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Animation, KeyframeEffect, AnimationEffect, the timelines, CSSAnimation and CSSTransition, generated from their IDL:
# made by the platform alone where IDL gives no constructor, their members on the prototypes (enumerable), their state
# in slots. Headless Chrome's figures.
RSpec.describe 'Web Animations bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><div id=d></div>']] })
    s.visit('/')
    s
  }

  # A DocumentTimeline's current time is the document's less its origin time, and it has no duration; element.animate()
  # plays on its options' timeline — null too — by none of the page's members; setting an animation's timeline keeps a
  # pending play's hold time (§4.4.1); overallProgress is its current time over its effect's end.
  it 'is what their IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
        const d = document.getElementById('d');
        const a = d.animate({opacity: [0, 1]}, 1000);
        const t = new DocumentTimeline({originTime: 100});
        const played = [];
        const play = Animation.prototype.play;
        Animation.prototype.play = function () { played.push(1); return play.call(this); };
        const b = d.animate({opacity: [0, 1]}, {duration: 1000, timeline: null});
        Animation.prototype.play = play;
        a.pause();
        a.currentTime = 250;
        const progress = a.overallProgress;
        const c = new Animation(new KeyframeEffect(d, null, 1000));
        c.play();
        c.currentTime = 100;
        c.timeline = null;
        return [
          err(() => new AnimationEffect()), err(() => new AnimationTimeline()), err(() => new CSSAnimation()),
          err(() => new CSSTransition()), Object.keys(Animation.prototype).includes('play'),
          Object.keys(KeyframeEffect.prototype).includes('target'), Math.round(document.timeline.currentTime - t.currentTime),
          document.timeline.duration, played.length, b.timeline, progress, c.timeline, c.currentTime, c.playState,
          err(() => { a.playbackRate = Infinity; })
        ];
      })()
    JS
    expect(got).to eq([
      'TypeError', 'TypeError', 'TypeError', 'TypeError', true, true, 100, nil, 0, nil, 0.25, nil, 100, 'running', 'TypeError'
    ])
  end
end
