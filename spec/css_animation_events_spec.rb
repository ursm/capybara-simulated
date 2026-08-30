# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A CSS animation or transition as an object a page can hold — `CSSAnimation` / `CSSTransition` —
# and the events they fire. A page waits for a transition by listening for `transitionend`, not by
# reading a computed value: every "fade it out, then remove it" helper is written that way, and
# until these events existed each of them waited for something that never came.
#
# The events are fired from the RENDERING UPDATE, as a browser fires them, so they arrive in frame
# order rather than at the moment a style is written. Every figure here is measured against a real
# Chrome 151 (through Playwright — headless `--dump-dom` freezes the animation clock and reports no
# events at all).
RSpec.describe 'CSS animation and transition events' do
  def page(markup)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"><style>
               @keyframes grow { from { flex-grow: 0 } to { flex-grow: 4 } }
               .go   { animation: grow 300ms linear }
               .fade { transition: flex-grow 300ms linear }
               .to   { flex-grow: 7 }
             </style></head><body style="margin:0;font:16px Arial">#{markup}</body></html>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  # Listen for everything, then make the change that starts them — which is the order a page does it
  # in, and the only order in which the first event can be observed.
  def watch(session)
    session.execute_script(<<~JS)
      window.log = [];
      setInterval(() => {}, 1000);          // the page has work, so the clock steps
      for (const t of ['animationstart', 'animationiteration', 'animationend', 'animationcancel',
                       'transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) {
        document.addEventListener(t, (e) => {
          window.log.push([t, e.animationName ?? e.propertyName, e.elapsedTime, e.target.id, e.bubbles].join(':'));
        });
      }
    JS
  end

  def drain(session, steps = 6)
    steps.times { session.evaluate_script('1') }
    session.evaluate_script('window.log')
  end

  # The whole sequence for one class change that starts an animation on one element and a transition
  # on another — including the ORDER, which is the transitions of the frame before its animations.
  it 'fires the animation and transition events of a frame in composite order' do
    s = page('<div id="a"></div><div id="b" class="fade"></div>')
    watch(s)
    s.execute_script(<<~JS)
      document.getElementById('a').className = 'go';
      document.getElementById('b').className = 'fade to';
    JS
    expect(drain(s)).to eq([
      'transitionrun:flex-grow:0:b:true',
      'transitionstart:flex-grow:0:b:true',
      'animationstart:grow:0:a:true',
      'transitionend:flex-grow:0.3:b:true',
      'animationend:grow:0.3:a:true'
    ])
  end

  # `elapsedTime` is in SECONDS and counts the time the animation has been running, so an
  # `animationiteration` names the iteration it reached.
  it 'fires one animationiteration per boundary crossed' do
    s = page('<div id="a"></div>')
    watch(s)
    s.execute_script("document.getElementById('a').style.animation = 'grow 200ms linear 3'")
    log = drain(s, 8)
    expect(log.grep(/animationiteration/)).to eq(['animationiteration:grow:0.2:a:true',
                                                  'animationiteration:grow:0.4:a:true'])
    expect(log.last).to eq('animationend:grow:0.6:a:true')
  end

  # …and ONE per frame, not one per boundary: a frame that spans several iterations owes a single
  # event, naming the iteration it landed on (Chrome-measured — 19 boundaries over four frames fire
  # four events). Here 40ms iterations against the driver's 100ms step cross two or three at a time.
  it 'fires one animationiteration per frame, not per boundary' do
    s = page('<div id="a"></div>')
    watch(s)
    s.execute_script("document.getElementById('a').style.animation = 'grow 40ms linear 8'")
    iterations = drain(s, 6).grep(/animationiteration/)
    expect(iterations).to eq(['animationiteration:grow:0.08:a:true',
                              'animationiteration:grow:0.2:a:true',
                              'animationiteration:grow:0.28:a:true'])
  end

  # A NEGATIVE delay starts the animation part way through, and the first event says how far
  # (Chrome: `grow 300ms linear -100ms` reports `animationstart` at 0.1, not 0).
  it 'reports what a negative delay skipped' do
    s = page('<div id="a"></div>')
    watch(s)
    s.execute_script("document.getElementById('a').style.animation = 'grow 300ms linear -100ms'")
    log = drain(s, 4)
    expect(log.first).to eq('animationstart:grow:0.1:a:true')
    expect(log.last).to eq('animationend:grow:0.3:a:true')
  end

  # Sending a property back where it came from is a NEW transition, and the page is told the first
  # one died: Chrome fires cancel, then a fresh run and start, then the end.
  it 'cancels and restarts a reversed transition' do
    s = page('<div id="b" style="transition: flex-grow 400ms linear"></div>')
    watch(s)
    s.execute_script("document.getElementById('b').style.flexGrow = '10'")
    2.times { s.evaluate_script('1') }
    s.execute_script("document.getElementById('b').style.flexGrow = '0'")
    expect(drain(s).map {|e| e.split(':').first }).to eq(
      %w[transitionrun transitionstart transitioncancel transitionrun transitionstart transitionend]
    )
  end

  # An animation the cascade stops naming part way through is CANCELLED, not ended — and its
  # `elapsedTime` is how long it had been running, not zero.
  it 'cancels an animation the cascade stops naming' do
    s = page('<div id="a" class="go"></div>')
    watch(s)
    s.evaluate_script('1')
    s.execute_script("document.getElementById('a').className = ''")
    cancel = drain(s, 3).grep(/animationcancel/).first
    expect(cancel).to start_with('animationcancel:grow:')
    expect(cancel.split(':')[2].to_f).to be_between(0.05, 0.3).exclusive
  end

  # An element that stops being rendered runs nothing: its transitions are cancelled rather than
  # ended, and one that BECOMES rendered has no before-change style to transition from.
  it 'cancels a transition on an element that stops being rendered' do
    s = page('<div id="b" class="fade"></div>')
    watch(s)
    s.execute_script("document.getElementById('b').className = 'fade to'")
    s.evaluate_script('1')
    s.execute_script("document.getElementById('b').style.display = 'none'")
    cancel = drain(s, 3).grep(/transitioncancel/).first
    expect(cancel).to start_with('transitioncancel:flex-grow:')
    expect(cancel.split(':')[2].to_f).to be_between(0.05, 0.3).exclusive
  end

  it 'does not transition an element that has just become rendered' do
    s = page('<div id="b" class="fade" style="display:none"></div>')
    value = s.evaluate_script(<<~JS)
      (function () {
        const el = document.getElementById('b');
        getComputedStyle(el).flexGrow;             // resolve the before-change style — of nothing
        el.style.display = 'block';
        el.classList.add('to');
        return getComputedStyle(el).flexGrow;      // …so it lands on the new value at once
      })()
    JS
    expect(value).to eq('7')
  end

  describe 'the objects' do
    # `getAnimations()` reports CSS-driven animations too, as `CSSAnimation` / `CSSTransition`,
    # transitions first — and drops one that has finished and holds no value.
    it 'reports CSS animations and transitions' do
      s = page('<div id="a"></div>')
      s.execute_script(<<~JS)
        setInterval(() => {}, 1000);
        document.getElementById('a').className = 'go';
      JS
      s.evaluate_script('1')
      listed = s.evaluate_script(<<~JS)
        document.getAnimations().map((a) => a.constructor.name + ':' + (a.animationName ?? a.transitionProperty))
      JS
      expect(listed).to eq(['CSSAnimation:grow'])
      4.times { s.evaluate_script('1') }
      expect(s.evaluate_script('document.getAnimations().length')).to eq(0)
    end

    # A transition reports the PHYSICAL property name whichever spelling the page transitioned —
    # `padding-left`, never `padding-inline-start` — and a SHORTHAND transitions every longhand
    # under it.
    it 'names the physical property a shorthand transitioned' do
      s = page('<div id="c" style="transition: padding 300ms linear"></div>')
      watch(s)
      s.execute_script("document.getElementById('c').style.paddingLeft = '20px'")
      expect(drain(s).grep(/transitionend/)).to eq(['transitionend:padding-left:0.3:c:true'])
    end
  end

  # An animation the cascade REPLACES owes its cancel before the replacement's start — the order a
  # page relies on to tell "this one died" from "that one began".
  it 'cancels the animation it replaces before starting the new one' do
    s = page('<div id="a" class="go"></div>')
    watch(s)
    s.evaluate_script('1')
    s.execute_script(<<~JS)
      const sheet = document.styleSheets[0];
      sheet.insertRule('@keyframes shrink { from { flex-grow: 4 } to { flex-grow: 0 } }', sheet.cssRules.length);
      document.getElementById('a').style.animation = 'shrink 300ms linear';
    JS
    types = drain(s, 2).map {|e| e.split(':').first }
    expect(types.index('animationcancel')).to be < types.index('animationstart')
  end

  # The event interfaces themselves: readonly attributes, a required `type`, and the WebIDL
  # conversions (`null` is the string "null"; a non-finite `elapsedTime` is a TypeError).
  it 'constructs the event interfaces as WebIDL says' do
    s = page('<div id="a"></div>')
    expect(s.evaluate_script(<<~JS)).to eq([true, true, 'null', 0, true])
      (function () {
        const missingType = (() => { try { new AnimationEvent(); return false; } catch (e) { return e instanceof TypeError; } })();
        const nonFinite = (() => {
          try { new TransitionEvent('t', { elapsedTime: Infinity }); return false; } catch (e) { return e instanceof TypeError; }
        })();
        const e = new AnimationEvent('animationend', { animationName: null, elapsedTime: 0 });
        const readonly = (() => { try { e.elapsedTime = 5; } catch (_) {} return e.elapsedTime === 0; })();
        return [missingType, nonFinite, e.animationName, e.elapsedTime, readonly];
      })()
    JS
  end
end
