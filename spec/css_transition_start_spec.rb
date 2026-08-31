# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# WHEN a transition starts. A browser compares the property's computed value against what it
# computed at the last STYLE CHANGE EVENT, and the two halves of that sentence are what this file
# pins: which moments are style change events, and what "computed value" means when the element
# does not declare the property at all.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'starting a transition' do
  def page(markup, style = '')
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               body { margin: 0; font: 16px Arial }
               #{style}
             </style></head><body>#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # The idiom every page uses to start a transition: give the element its `transition` declaration,
  # force a reflow, then change the value. The reflow is a STYLE FLUSH — a browser recomputes style
  # there, and that computation is what the change is then measured against.
  it 'treats a forced reflow as a style change event' do
    s = page('<div id="a" class="box"></div>', <<~CSS)
      .box  { background-color: rgb(0,0,0); width: 50px; height: 50px }
      .how  { transition: background-color 2s linear }
      .to   { background-color: rgb(100,100,100) }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq('rgb(0, 0, 0)')
      (function () {
        const a = document.getElementById('a');
        a.classList.add('how');
        document.body.offsetWidth;              // the flush
        a.classList.add('to');
        return getComputedStyle(a).backgroundColor;
      })()
    JS
  end

  # …and a computed-value READ is one too, which is the other way a page forces the recalc.
  it 'treats a computed-value read as a style change event' do
    s = page('<div id="a" class="box"></div>', <<~CSS)
      .box  { background-color: rgb(0,0,0); width: 50px; height: 50px }
      .how  { transition: background-color 2s linear }
      .to   { background-color: rgb(100,100,100) }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq('rgb(0, 0, 0)')
      (function () {
        const a = document.getElementById('a');
        a.classList.add('how');
        getComputedStyle(a).backgroundColor;
        a.classList.add('to');
        return getComputedStyle(a).backgroundColor;
      })()
    JS
  end

  # A property the element does not declare still HAS a computed value — the one it inherits — and
  # a change to that is a change to transition. A theme switch moves `color` on one element and
  # every descendant that asks for it transitions (Chrome-measured: the child reports the old
  # colour, and `getAnimations()` names its own run).
  it 'starts on a change to an inherited value' do
    s = page('<div id="p" class="c"><div id="k" class="kid">x</div></div>', <<~CSS)
      .c      { color: rgb(0,0,0) }
      .c.to   { color: rgb(100,100,100) }
      .kid.how { transition: color 2s linear }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq(['rgb(0, 0, 0)', 'color'])
      (function () {
        const p = document.getElementById('p'), k = document.getElementById('k');
        k.classList.add('how');
        document.body.offsetWidth;
        p.classList.add('to');
        return [getComputedStyle(k).color, k.getAnimations().map((a) => a.transitionProperty).join('+')];
      })()
    JS
  end

  # The comparison is between COMPUTED values, not between the two declared texts: `padding-left:
  # 1em` does not change when `font-size` does, but what it computes to doubles — and that is a
  # change (Chrome: the child reports `10px`, the old em, while the new one is 20).
  it 'starts on a computed value that changed under an unchanged declaration' do
    s = page('<div id="p" class="c"><div id="k" class="kid">x</div></div>', <<~CSS)
      .c       { font-size: 10px }
      .c.to    { font-size: 20px }
      .kid     { padding-left: 1em }
      .kid.how { transition: padding-left 2s linear }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq(['10px', 'padding-left'])
      (function () {
        const p = document.getElementById('p'), k = document.getElementById('k');
        k.classList.add('how');
        document.body.offsetWidth;
        p.classList.add('to');
        return [getComputedStyle(k).paddingLeft,
                k.getAnimations().map((a) => a.transitionProperty).join('+')];
      })()
    JS
  end

  # …and a change that is inherited from an element ALREADY TRANSITIONING the same property starts
  # nothing (css-transitions §3): what this element shows is that transition's value, arriving
  # through inheritance, and a second run would go alongside it. WPT
  # `properties-value-inherit-001` is the case.
  it 'does not start a second run under a transitioning parent' do
    s = page('<div id="p" class="c"><div id="k" class="kid">x</div></div>', <<~CSS)
      .c       { color: rgb(0,0,0) }
      .c.to    { color: rgb(100,100,100) }
      .c.how   { transition: color 2s linear }
      .kid     { color: inherit }
      .kid.how { transition: color 2s linear }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq(['rgb(0, 0, 0)', 1, 0])
      (function () {
        const p = document.getElementById('p'), k = document.getElementById('k');
        p.classList.add('how');
        k.classList.add('how');
        document.body.offsetWidth;
        p.classList.add('to');
        return [getComputedStyle(k).color, p.getAnimations().length, k.getAnimations().length];
      })()
    JS
  end

  # An element that has just appeared has no before-change style, so it lands on its value rather
  # than transitioning to it — the flush must not invent a baseline for one that was not rendered.
  it 'does not transition an element that has just appeared' do
    s = page('<div id="a" class="how" style="display:none"></div>', <<~CSS)
      .how { background-color: rgb(0,0,0); transition: background-color 2s linear }
      .to  { background-color: rgb(100,100,100) }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq('rgb(100, 100, 100)')
      (function () {
        const a = document.getElementById('a');
        document.body.offsetWidth;
        a.style.display = 'block';
        a.classList.add('to');
        return getComputedStyle(a).backgroundColor;
      })()
    JS
  end

  # Two reads in a row with NOTHING changed between them are one style change event, not two: the
  # second must not measure against the first, or nothing ever looks changed.
  it 'treats consecutive reads with nothing dirty as one event' do
    s = page('<div id="a" class="box"></div>', <<~CSS)
      .box  { background-color: rgb(0,0,0); width: 50px; height: 50px }
      .how  { transition: background-color 2s linear }
      .to   { background-color: rgb(100,100,100) }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq('rgb(0, 0, 0)')
      (function () {
        const a = document.getElementById('a');
        a.classList.add('how');
        getComputedStyle(a).backgroundColor;
        getComputedStyle(a).backgroundColor;
        a.classList.add('to');
        return getComputedStyle(a).backgroundColor;
      })()
    JS
  end

  # …and the everyday pair — the transition and the value written together, after something has
  # looked once — transitions from the value that read saw.
  it 'starts on a transition and a value written together' do
    s = page('<div id="a" class="box"></div>', '.box { background-color: rgb(0,0,0) }')
    expect(s.evaluate_script(<<~JS)).to eq('rgb(0, 0, 0)')
      (function () {
        const a = document.getElementById('a');
        getComputedStyle(a).backgroundColor;
        a.style.transition = 'background-color 2s linear';
        a.style.backgroundColor = 'rgb(100,100,100)';
        return getComputedStyle(a).backgroundColor;
      })()
    JS
  end

  # A flow-relative name and its physical twin are ONE value, and one baseline: `block-size` and
  # `height` in a block transition from what the block computed to, not from a value the other name
  # was last seen with.
  it 'keeps one baseline for a flow-relative pair' do
    s = page('<div id="a"></div>', <<~CSS)
      #a    { block-size: 0px; height: 200px; transition: block-size 10s linear -5s, height 10s linear -5s }
      #a.to { block-size: 100px; height: 300px }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq('250px')
      (function () {
        const a = document.getElementById('a');
        getComputedStyle(a).height;
        a.classList.add('to');
        return getComputedStyle(a).height;
      })()
    JS
  end

  # The flush RECORDS; it fires nothing. Events belong to the rendering update, which is where a
  # browser dispatches them (Chrome fires no `transitionrun` / `transitionstart` / `transitionend`
  # around a forced `offsetWidth`, however many transitions it starts).
  it 'fires nothing from the flush itself' do
    s = page('<div id="a" class="box"></div>', <<~CSS)
      .box  { background-color: rgb(0,0,0); width: 50px; height: 50px }
      .how  { transition: background-color 2s linear }
      .to   { background-color: rgb(100,100,100) }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq([])
      (function () {
        const log = [];
        for (const t of ['transitionrun', 'transitionstart', 'transitionend', 'animationstart']) {
          document.addEventListener(t, () => log.push(t));
        }
        const a = document.getElementById('a');
        a.classList.add('how');
        document.body.offsetWidth;
        a.classList.add('to');
        getComputedStyle(a).backgroundColor;
        return log;
      })()
    JS
  end

  # A shadow child inherits from its HOST — style descends the flat tree — so a change on the host
  # is a change on it.
  it 'inherits a change through the flat tree' do
    s = page('<div id="h" class="host"></div>', <<~CSS)
      .host    { color: rgb(0,0,0) }
      .host.to { color: rgb(100,100,100) }
    CSS
    expect(s.evaluate_script(<<~JS)).to eq('rgb(0, 0, 0)')
      (function () {
        const h = document.getElementById('h');
        const root = h.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>div { transition: color 2s linear }</style><div id="s">s</div>';
        const kid = root.getElementById('s');
        getComputedStyle(kid).color;
        h.classList.add('to');
        return getComputedStyle(kid).color;
      })()
    JS
  end
end
