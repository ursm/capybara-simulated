# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What an animation op moves of what an element shows — a paused one sought, canceled, its effect's keyframes or
# target changed — no clock moves and no DOM change says: the op marks the element it touched to be laid out again
# (animation_ops.rs `with_engine_marking`), and the box reads where the animation now puts it — a read that asks first
# whether the element is rendered too, which answers off the generations before any style flush.
RSpec.describe "an animation op's layout" do
  it 'lays out what a paused animation sought, a target or keyframes changed now show' do
    html = '<!DOCTYPE html><meta charset="utf-8"><body style="margin:0"><div id=a style="width:10px;height:10px"></div>' \
           '<div id=b style="width:10px;height:10px"></div>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a'), b = document.getElementById('b');
        const width = (el) => el.getBoundingClientRect().width;
        const anim = a.animate([{ width: '0px' }, { width: '200px' }], 1000);
        anim.pause();
        const out = [];
        anim.currentTime = 500; out.push(width(a));
        anim.currentTime = 250; out.push(width(a));
        anim.effect.setKeyframes([{ width: '0px' }, { width: '400px' }]); out.push(width(a));
        anim.effect.target = b; out.push(width(a), width(b));
        return out;
      })()
    JS
    expect(read).to eq([100, 50, 100, 10, 100])
  end

  it 'renders again what a canceled `display: none` animation hid, read in the same turn' do
    html = '<!DOCTYPE html><meta charset="utf-8"><body style="margin:0"><p id=p><span id=a style="display:block;height:10px">hello</span>world</p>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    read = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p'), a = document.getElementById('a');
        const seen = () => [p.innerText.includes('hello'), a.checkVisibility(), a.offsetHeight, a.getClientRects().length];
        const anim = a.animate([{ display: 'none' }, { display: 'none' }], 1000);
        anim.pause();
        const hidden = seen();
        anim.cancel();
        return [hidden, seen()];
      })()
    JS
    expect(read).to eq([[false, false, 0, 0], [true, true, 10, 1]])
  end
end
