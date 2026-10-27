# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# What an animation op moves of what an element shows — a paused one sought, its effect's keyframes or target changed —
# no clock moves and no DOM change says: the element the op touched is restyled at the next style flush, which marks
# it to be laid out again (layout.js `markRestyles`), and the box reads where the animation now puts it.
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
end
