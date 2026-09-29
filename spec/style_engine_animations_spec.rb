# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSS animations and transitions in the style engine: its Web Animations model runs them, the page's clock moves them
# (an animation-only restyle each time it does), and a rendering update fires the events the phases they moved through
# owe. Each example drives the clock the way a page does — a pending interval keeps it stepping,
# and every script evaluation is a step — with CSIM_STYLE_VERIFY holding each incremental restyle against a full one.
RSpec.describe 'style engine animations' do
  around do |example|
    saved = ENV.values_at('CSIM_STYLO', 'CSIM_STYLE_VERIFY')
    ENV['CSIM_STYLO'] = '1'
    ENV['CSIM_STYLE_VERIFY'] = '1'
    example.run
  ensure
    ENV['CSIM_STYLO'], ENV['CSIM_STYLE_VERIFY'] = saved
  end

  def page(body, css = '')
    html = <<~HTML
      <!DOCTYPE html><html><head><style>
        @keyframes fade { from { opacity: 1 } to { opacity: 0 } }
        @keyframes widen { from { letter-spacing: 1em } to { letter-spacing: 3em } }
        #{css}
      </style></head><body>#{body}</body></html>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.log = [];
      setInterval(() => {}, 1000);
      for (const t of ['animationstart', 'animationiteration', 'animationend', 'animationcancel',
                       'transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) {
        document.addEventListener(t, (e) => {
          window.log.push([t, e.animationName ?? e.propertyName, e.elapsedTime, e.target.id].join(':'));
        });
      }
    JS
    s
  end

  def drain(session, steps = 6)
    steps.times { session.evaluate_script('1') }
    session.evaluate_script('window.log')
  end

  # A frame's events go transitions first, then animations, each in tree order — and a time is the one written
  # (`0.3`), not the single-precision float the engine keeps it as.
  it 'fires the events of a frame in composite order, with the times written' do
    s = page('<div id="a"></div><div id="b" style="transition: opacity 300ms linear"></div>')
    s.execute_script(<<~JS)
      document.getElementById('a').style.animation = 'fade 300ms linear';
      document.getElementById('b').style.opacity = '0';
    JS
    expect(drain(s)).to eq(%w[
      transitionrun:opacity:0:b transitionstart:opacity:0:b animationstart:fade:0:a
      transitionend:opacity:0.3:b animationend:fade:0.3:a
    ])
  end

  # A `getComputedStyle` between two frames is a style flush, not a rendering update: it fires nothing of its own, so
  # a frame that crossed several iteration boundaries owes one event, at the iteration it landed on.
  it 'fires one animationiteration per frame, not one per style flush' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 40ms linear 8'")
    6.times { s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity") }
    iterations = s.evaluate_script('window.log').grep(/animationiteration/)
    expect(iterations.size).to be < 6
    expect(iterations.map {|e| e.split(':')[2].to_f }).to eq(iterations.map {|e| e.split(':')[2].to_f }.sort.uniq)
  end

  # A transition sent back where it came from is a new one, and the page is told the first one died.
  it 'cancels a reversed transition before running its replacement' do
    s = page('<div id="b" style="transition: opacity 400ms linear"></div>')
    s.execute_script("document.getElementById('b').style.opacity = '0'")
    2.times { s.evaluate_script('1') }
    s.execute_script("document.getElementById('b').style.opacity = '1'")
    expect(drain(s).map {|e| e.split(':').first }).to eq(
      %w[transitionrun transitionstart transitioncancel transitionrun transitionstart transitionend]
    )
  end

  # An element that inherits a property its parent starts transitioning transitions it too — to the value its after-
  # change style inherits, the parent's own after-change value (css-transitions-1 §3; WPT
  # after-change-style-inherited) — once, not again frame after frame as the parent's value moves.
  it 'transitions once under a parent transitioning the same property' do
    s = page(
      '<div id="p" class="c"><div id="k" class="kid">x</div></div>',
      '.c { color: rgb(0, 0, 0); transition: color 300ms linear } .c.to { color: rgb(100, 100, 100) }
       .kid { color: inherit; transition: color 300ms linear }'
    )
    s.execute_script("getComputedStyle(document.getElementById('k')).color; document.getElementById('p').classList.add('to')")
    expect(drain(s).grep(/:k$/)).to eq(%w[transitionrun:color:0:k transitionstart:color:0:k transitionend:color:0.3:k])
  end

  # A read of a value another model answers (`direction` is still the JS side's) is a style flush all the same, and
  # the before-change style a transition compares against is the one it saw — here the only one an element added a
  # moment before ever had.
  it 'starts a transition from the style a flush of another value saw' do
    s = page('')
    s.execute_script(<<~JS)
      const b = document.body.appendChild(document.createElement('div'));
      b.id = 'b';
      b.style.transition = 'opacity 300ms linear';
      getComputedStyle(b).direction;
      b.style.opacity = '0';
    JS
    expect(drain(s).grep(/transitionend/)).to eq(['transitionend:opacity:0.3:b'])
  end

  # Moving an animation's delay moves where it is: past its first iteration is an `animationiteration`, past its
  # last is its end (the iteration count is not counted twice when the delay changes again).
  it 'follows an animation whose delay moves it on' do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      const a = document.getElementById('a');
      a.addEventListener('animationstart', () => { a.style.animationDelay = '-100s' });
      a.addEventListener('animationiteration', () => { a.style.animationDelay = '-200s' });
      a.style.animation = 'fade 100s linear 2';
    JS
    expect(drain(s)).to eq(%w[animationstart:fade:0:a animationiteration:fade:100:a animationend:fade:200:a])
  end

  # A finished animation with a fill keeps its value through a later restyle (it stays for as long as
  # `animation-name` lists it, the same animation rather than a new start), and one the cascade stops naming takes
  # its value with it.
  it 'holds a fill through a restyle, and drops the value of an animation no longer named' do
    s = page('<div id="a"></div>', '.gone { animation: none !important }')
    s.execute_script("document.getElementById('a').style.animation = 'fade 100ms linear forwards'")
    drain(s, 4)
    s.execute_script("document.getElementById('a').style.animationTimingFunction = 'ease'")
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity")).to eq('0')
    expect(drain(s, 2)).to eq(%w[animationstart:fade:0:a animationend:fade:0.1:a])
    s.execute_script("document.getElementById('a').className = 'gone'")
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity")).to eq('1')
  end

  # An element that stops being rendered runs nothing: `display: none` cancels what it was running.
  it 'cancels the animation of an element that stops being rendered' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 100s linear'")
    drain(s, 2)
    s.execute_script("document.getElementById('a').style.display = 'none'")
    expect(drain(s, 2).map {|e| e.split(':').first }).to eq(%w[animationstart animationcancel])
  end

  # Keyframes are computed values of the element they run on, taken again whenever it is restyled: an `em` follows
  # its font size.
  it 'computes keyframes again when the element they run on changes' do
    s = page('<div id="a" style="font-size: 10px; animation: widen 4s linear -2s paused"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const before = getComputedStyle(a).letterSpacing;
        a.style.fontSize = '20px';
        return [before, getComputedStyle(a).letterSpacing];
      })()
    JS
    expect(read).to eq(%w[20px 40px])
  end

  # …and an `inherit` in them follows the parent it inherits from.
  it 'computes keyframes again when the style they inherit changes' do
    s = page(
      '<div id="p"><div id="a"></div></div>',
      '@keyframes lh { from { line-height: inherit } to { line-height: 20px } }
       #a { animation: lh 4s linear -2s paused }'
    )
    read = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p'), a = document.getElementById('a');
        p.style.lineHeight = '100px';
        const first = getComputedStyle(a).lineHeight;
        p.style.lineHeight = '50px';
        return [first, getComputedStyle(a).lineHeight];
      })()
    JS
    expect(read).to eq(%w[60px 35px])
  end

  # A second name added to an element already animating starts too (stylo stopped at the first it had).
  it 'starts an animation added beside one already running' do
    s = page('<div id="a"></div>', '@keyframes k2 { from { color: rgb(0, 0, 0) } to { color: rgb(100, 100, 100) } }')
    s.execute_script("document.getElementById('a').style.animation = 'fade 100s linear'")
    drain(s, 2)
    s.execute_script("document.getElementById('a').style.animation = 'fade 100s linear, k2 100ms linear'")
    expect(drain(s, 3)).to eq(%w[animationstart:fade:0:a animationstart:k2:0:a animationend:k2:0.1:a])
  end

  # A zero duration still runs: its whole active interval is the instant it starts, and its fill holds the end.
  it 'runs an animation of zero duration' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 0s forwards'")
    expect(drain(s, 2)).to eq(%w[animationstart:fade:0:a animationend:fade:0:a])
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity")).to eq('0')
  end

  # A duration too short for the clock's precision to step through is iterated in one step, not boundary by
  # boundary (which never ended).
  it 'iterates a vanishingly short animation in one step' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 0.0000000001ms linear infinite'")
    drain(s, 3)
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).animationName")).to eq('fade')
  end

  # An animation that is over is not canceled by being taken away (CSS Animations 2: only one not idle and not
  # after is); one that is running reports how long it has run, all its iterations counted.
  it 'cancels only what is running, with the time it has run' do
    s = page('<div id="a"></div><div id="b"></div>')
    s.execute_script(<<~JS)
      document.getElementById('a').style.animation = 'fade 10ms forwards';
      document.getElementById('b').style.animation = 'fade 300ms linear infinite';
    JS
    drain(s, 10)
    s.execute_script("document.getElementById('a').style.animation = ''; document.getElementById('b').style.display = 'none'")
    cancels = drain(s, 2).grep(/animationcancel/)
    expect(cancels.size).to eq(1)
    expect(cancels.first).to start_with('animationcancel:fade:')
    expect(cancels.first.split(':')[2].to_f).to be > 0.6
  end

  # Events due in one frame are dispatched in the order they fell due, before composite order.
  it 'fires the events of a frame in the order they were due' do
    s = page('<div id="a"></div><div id="b"></div>')
    s.execute_script(<<~JS)
      document.getElementById('a').style.animation = 'fade 250ms linear';
      document.getElementById('b').style.animation = 'fade 210ms linear';
    JS
    expect(drain(s).grep(/animationend/)).to eq(%w[animationend:fade:0.21:b animationend:fade:0.25:a])
  end

  # An elapsed time of zero is 0, not -0 (a delay of 0 is no negative one).
  it 'reports an elapsed time of zero as 0' do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      window.negative = [];
      document.getElementById('a').addEventListener('animationstart', (e) => window.negative.push(Object.is(e.elapsedTime, -0)));
      document.getElementById('a').style.animation = 'fade 100s';
    JS
    drain(s, 2)
    expect(s.evaluate_script('window.negative')).to eq([false])
  end

  # …and its value goes with it, then and after.
  it 'drops the animated value of an element that stops being rendered' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 10s linear'")
    drain(s, 2)
    s.execute_script("document.getElementById('a').style.display = 'none'")
    reads = 2.times.map { s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity") }
    expect(reads).to eq(%w[1 1])
  end

  # A paused animation is where its progress says: one paused in its delay has not started.
  it 'starts no paused animation still in its delay' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 1s linear 5s paused'")
    expect(drain(s, 3)).to eq([])
  end

  # A zero-length animation paused and resumed ends where it would have, its fill holding the end.
  it 'resumes a paused animation of zero duration' do
    s = page('<div id="a"></div>')
    s.execute_script("document.getElementById('a').style.animation = 'fade 0s paused forwards'")
    drain(s, 2)
    s.execute_script("document.getElementById('a').style.animationPlayState = 'running'")
    drain(s, 2)
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity")).to eq('0')
  end

  # At an iteration's end exactly, the next has begun: the value is its first keyframe's — the animation's, never
  # the element's own (1) for the frame a boundary falls on.
  it 'reads the next iteration at an iteration boundary' do
    s = page('<div id="a"></div>', '@keyframes half { from { opacity: 0.5 } to { opacity: 0.9 } }')
    s.execute_script("document.getElementById('a').style.animation = 'half 200ms linear infinite'")
    reads = 6.times.map { s.evaluate_script("getComputedStyle(document.getElementById('a')).opacity") }
    expect(reads).to include('0.5')
    expect(reads).not_to include('1')
  end

  # …and so is the end of a delay: the underlying value before it, the first keyframe from it on. (A CSS animation
  # starts pending — its start time is the frame it becomes ready in — so each read says where it is.)
  it 'reads the first keyframe where a delay ends' do
    s = page('<div id="a"></div>', '@keyframes half { from { opacity: 0.5 } to { opacity: 0.9 } }')
    s.execute_script("document.getElementById('a').style.animation = 'half 1s linear 200ms'")
    reads = 5.times.map {
      s.evaluate_script(<<~JS)
        (() => {
          const a = document.getElementById('a');
          const opacity = getComputedStyle(a).opacity;
          return [a.getAnimations()[0].currentTime, opacity];
        })()
      JS
    }
    expect(reads.select {|time, _| time < 200 }.map(&:last).uniq).to eq(['1'])
    expect(reads.find {|time, _| time == 200 }&.last).to eq('0.5')
  end

  # A reversed transition that started part way (a negative delay) is held against a full restyle that knows only
  # what is running — not the transition it replaced.
  it 'reverses a transition with a negative delay' do
    s = page('<div id="b" style="transition: opacity 600ms linear -100ms"></div>')
    s.execute_script("document.getElementById('b').style.opacity = '0'")
    2.times { s.evaluate_script('1') }
    s.execute_script("document.getElementById('b').style.opacity = '1'")
    expect(drain(s).map {|e| e.split(':').first }).to eq(
      %w[transitionrun transitionstart transitioncancel transitionrun transitionstart transitionend]
    )
  end

  # A pseudo-element's values are its animations' too.
  it "reads a pseudo-element's animated value" do
    s = page('<div id="a"></div>', '#a::before { content: "b"; animation: fade 1s linear }')
    drain(s, 3)
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a'), '::before').opacity").to_f).to be < 1
  end

  # ── Script animations (`element.animate`), the engine's own model ──
  # Values are composed in the engine at the page's clock; `ready` waits for a frame; a pause holds, a seek moves, and
  # a value layout answers (`width`) follows the engine too.
  it 'runs a script animation on the page clock' do
    s = page('<div id="a" style="opacity: 0.5"></div>')
    s.execute_script(<<~JS)
      window.steps = [];
      (async () => {
        const a = document.getElementById('a');
        const anim = a.animate([{ opacity: 0 }, { opacity: 1 }], 1000);
        await anim.ready;
        await new Promise((r) => setTimeout(r, 500));
        steps.push(getComputedStyle(a).opacity);
        anim.pause();
        await anim.ready;
        steps.push(anim.playState, getComputedStyle(a).opacity);
        anim.currentTime = 250;
        steps.push(getComputedStyle(a).opacity);
        const wide = a.animate({ width: ['100px', '200px'] }, { duration: 1000, fill: 'forwards' });
        wide.finish();
        steps.push(getComputedStyle(a).width);
        await wide.finished;
        steps.push('finished', a.getAnimations().length);
      })();
    JS
    drain(s, 10)
    expect(s.evaluate_script('window.steps')).to eq(['0.5', 'paused', '0.5', '0.25', '200px', 'finished', 2])
  end

  # A keyframe list without a 0% keyframe starts from the element's own value, and `composite: 'add'` adds to it.
  it 'composes a script animation over the value underneath' do
    s = page('<div id="a" style="margin-left: 100px"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const to = a.animate({ marginLeft: '200px' }, 1000);
        to.pause(); to.currentTime = 500;
        const neutral = getComputedStyle(a).marginLeft;
        to.cancel();
        const add = a.animate({ marginLeft: ['10px', '20px'] }, { duration: 1000, composite: 'add' });
        add.pause(); add.currentTime = 500;
        return [neutral, getComputedStyle(a).marginLeft];
      })()
    JS
    expect(read).to eq(%w[150px 115px])
  end

  # `finish` and `cancel` are dispatched at the rendering update after, and the promises settle before them.
  it "settles a script animation's promises and dispatches its events" do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      window.order = [];
      const anim = document.getElementById('a').animate({ opacity: [0, 1] }, 100);
      anim.finished.then(() => order.push('finished'));
      anim.onfinish = () => order.push('finish');
      const other = document.getElementById('a').animate({ opacity: [0, 1] }, 1000);
      other.finished.catch((e) => order.push(e.name));
      other.oncancel = () => order.push('cancel');
      other.cancel();
    JS
    drain(s, 4)
    expect(s.evaluate_script('window.order')).to eq(%w[AbortError cancel finished finish])
  end

  # The timing a page gives is the timing the engine runs: an infinite duration never finishes, a seek or rate that
  # is no number is a TypeError, and a play at rate 0 of a finished animation rewinds it.
  it 'takes the timing and times a page gives' do
    s = page('<div id="a"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const forever = a.animate({ opacity: [0, 1] }, { duration: Infinity });
        let threw = '';
        try { forever.finish() } catch (e) { threw = e.name }
        let nan = '';
        try { forever.currentTime = NaN } catch (e) { nan = e.name }
        const done = a.animate({ opacity: [0, 1] }, 1000);
        done.finish();
        done.playbackRate = 0;
        done.play();
        return [forever.playState, forever.effect.getComputedTiming().duration, threw, nan, done.currentTime];
      })()
    JS
    expect(read).to eq(['running', nil, 'InvalidStateError', 'TypeError', 0]).or eq(['running', Float::INFINITY, 'InvalidStateError', 'TypeError', 0])
  end

  # `iterationComposite: 'accumulate'` adds the last keyframe's value once per iteration run.
  it 'accumulates iterations' do
    s = page('<div id="a"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const anim = document.getElementById('a').animate({ marginLeft: ['0px', '10px'] },
                                                           { duration: 1000, iterations: 3, iterationComposite: 'accumulate' });
        anim.pause(); anim.currentTime = 2000;
        return getComputedStyle(document.getElementById('a')).marginLeft;
      })()
    JS
    expect(read).to eq('20px')
  end

  # An animation started with a style change still unflushed is in the style that change is compared in: the
  # before-change and after-change styles both hold its value, so the change starts no transition (WPT
  # Animatable/animate.html "does NOT trigger a style change event").
  it 'starts no transition by starting an animation' do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      const a = document.getElementById('a');
      window.ran = false;
      a.addEventListener('transitionrun', () => { window.ran = true });
      a.style.transition = 'opacity 100s';
      getComputedStyle(a).opacity;
      a.style.opacity = '0.5';
      a.animate({ opacity: [0, 1] }, 100000);
    JS
    drain(s, 3)
    expect(s.evaluate_script('window.ran')).to be(false)
  end

  # `commitStyles()` writes the animation's own place in the stack — not what animations above it show — and its fill;
  # a pseudo-element target is an error.
  it 'commits what the animation composes' do
    s = page('<div id="a"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const lower = a.animate({ opacity: [0.2, 0.2] }, 100000);
        a.animate({ opacity: [0.7, 0.7] }, 100000);
        lower.commitStyles();
        const back = a.animate({ marginLeft: ['30px', '40px'] }, { duration: 1000, delay: 5000, fill: 'backwards' });
        back.commitStyles();
        let threw = '';
        try { a.animate({ opacity: [0, 1] }, { duration: 1000, pseudoElement: '::before' }).commitStyles() } catch (e) { threw = e.name }
        return [a.style.opacity, a.style.marginLeft, threw];
      })()
    JS
    expect(read).to eq(%w[0.2 30px NoModificationAllowedError])
  end

  # An element a script animates shares no style with its siblings (stylo's sharing cache asks `has_animations`).
  it "keeps a script animation's values off the element's siblings" do
    s = page('<div id="p"><div class="x" id="a"></div><div class="x"></div><div class="x"></div></div>', '.y .x { color: blue }')
    read = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('a').animate({ opacity: [0.2, 0.2] }, 100000).pause();
        document.getElementById('p').className = 'y';
        return [...document.querySelectorAll('.x')].map((x) => getComputedStyle(x).opacity).join(',');
      })()
    JS
    expect(read).to eq('0.2,1,1')
  end

  # Animations finishing in one frame dispatch `finish` in the order they were made.
  it 'dispatches the finish events of one frame in composite order' do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      window.order = [];
      for (let i = 0; i < 8; i++) {
        document.getElementById('a').animate({ opacity: [0, 1] }, 150).onfinish = () => order.push(i);
      }
    JS
    drain(s, 4)
    expect(s.evaluate_script('window.order')).to eq((0..7).to_a)
  end

  # `commitStyles()` stands on what the CSS animations below it show.
  it 'commits a script animation over a CSS one' do
    s = page('<div id="a"></div>', '@keyframes hold { from, to { margin-left: 100px } } #a { animation: hold 100s }')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        getComputedStyle(a).marginLeft;
        const add = a.animate({ marginLeft: ['10px', '10px'] }, { duration: 100000, composite: 'add' });
        add.commitStyles();
        return a.style.marginLeft;
      })()
    JS
    expect(read).to eq('110px')
  end

  # An effect taken over by another animation leaves the first one's target readable — layout and all (its entry
  # went with it).
  it 'takes an effect from a playing animation' do
    s = page('<div id="a"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const first = a.animate({ opacity: [0.3, 0.3] }, 100000);
        const second = new Animation(first.effect);
        a.getBoundingClientRect();
        getComputedStyle(a).marginLeft;
        const idle = getComputedStyle(a).opacity;
        second.play();
        return [idle, first.effect, getComputedStyle(a).opacity, a.getAnimations().length];
      })()
    JS
    expect(read).to eq(['1', nil, '0.3', 1])
  end

  # A CSS animation's object is an Animation, and its effect a KeyframeEffect.
  it "reports a CSS animation's object as an Animation" do
    s = page('<div id="a" style="animation: fade 100s"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const anim = document.getAnimations()[0];
        return [anim instanceof Animation, anim.effect instanceof KeyframeEffect, anim.effect instanceof AnimationEffect];
      })()
    JS
    expect(read).to eq([true, true, true])
  end

  # Each event carries the object `getAnimations()` reports for what it is about.
  it 'carries the animation an event is about' do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      const a = document.getElementById('a');
      a.addEventListener('animationstart', (e) => { window.same = e.animation === a.getAnimations()[0] });
      a.style.animation = 'fade 100s linear';
    JS
    drain(s, 2)
    expect(s.evaluate_script('window.same')).to be(true)
  end

  # ── CSS animations as the model's own objects ──
  # A CSS animation is a `CSSAnimation` a page can hold: the same object each time it asks, naming its rule, its
  # effect targeting the element with the timing and keyframes the style gives it.
  it 'is a CSSAnimation the page can hold' do
    s = page('<div id="a" style="animation: fade 100s linear 2s"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const [anim] = a.getAnimations();
        const timing = anim.effect.getTiming();
        return [anim instanceof CSSAnimation, anim === a.getAnimations()[0], anim.animationName, anim.effect.target === a,
                timing.duration, timing.delay, anim.effect.getKeyframes().map((k) => k.opacity).join(),
                document.getAnimations().length];
      })()
    JS
    expect(read).to eq([true, true, 'fade', true, 100_000, 2000, '1,0', 1])
  end

  # A script that plays or pauses one takes its play state from the style (css-animations-2 §4.1): the style flipping
  # `animation-play-state` after a `play()` pauses nothing.
  it 'takes the play state from a script that played it' do
    s = page('<div id="a" style="animation: fade 100s paused"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const [anim] = a.getAnimations();
        const before = anim.playState;
        anim.play();
        a.style.animationPlayState = 'running';
        getComputedStyle(a).opacity;
        a.style.animationPlayState = 'paused';
        getComputedStyle(a).opacity;
        return [before, anim.playState];
      })()
    JS
    expect(read).to eq(%w[paused running])
  end

  # A keyframe that declares no `animation-composition` takes the effect's, which is the element's: `auto`.
  it "leaves a keyframe's composite to the effect" do
    s = page('<div id="a" style="animation: fade 100s; animation-composition: add"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const [anim] = document.getElementById('a').getAnimations();
        return anim.effect.getKeyframes().map((k) => k.composite);
      })()
    JS
    expect(read).to eq(%w[auto auto])
  end

  # Events are owed for where the phase moved from one frame to the next (css-animations-2 §4.2): a seek into the
  # active interval and back within one task owes none.
  it 'owes no events for a phase left and returned to between frames' do
    s = page('<div id="a" style="animation: fade 1s 10s"></div>')
    drain(s, 2)
    s.execute_script(<<~JS)
      window.log = [];
      const [anim] = document.getElementById('a').getAnimations();
      anim.currentTime = 10500;
      anim.currentTime = 0;
    JS
    expect(drain(s, 2)).to eq([])
  end

  # ── What the engine computes of a keyframe ──
  # `display` animates to or from `none` holding the other value in between (css-display-4 §2.9).
  it 'holds the value that is not none between the ends of a display animation' do
    s = page('<div id="a"></div><div id="b"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const at = (el, frames, time) => {
          const anim = el.animate({display: frames}, {duration: 1000, fill: 'forwards'});
          anim.pause();
          anim.currentTime = time;
          return getComputedStyle(el).display;
        };
        return [at(a, ['block', 'none'], 900), at(b, ['none', 'block'], 100)];
      })()
    JS
    expect(read).to eq(%w[block block])
  end

  # In one keyframe, a physical property wins over the logical one it maps to whatever order the page wrote them in
  # (a script's keyframe), and the one declared last wins in `@keyframes` (a rule's).
  it 'settles a physical property and its logical twin in one keyframe' do
    s = page('<div id="a"></div><div id="b" style="animation: logical 100s -50s paused"></div>',
             '@keyframes logical { from { margin-left: 10px; margin-inline-start: 20px } to { margin-left: 10px; margin-inline-start: 20px } }')
    # (Half way, where a keyframe keeping both would ease from one to the other.)
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const anim = a.animate({marginInlineStart: ['30px', '30px'], marginLeft: ['40px', '40px']}, 1000);
        anim.pause();
        anim.currentTime = 500;
        return [getComputedStyle(a).marginLeft, getComputedStyle(document.getElementById('b')).marginLeft];
      })()
    JS
    expect(read).to eq(%w[40px 20px])
  end

  # Two transform lists whose matrices cannot both be decomposed flip half way (css-transforms-2 §10), and the value
  # is a matrix a page can read — not a function kept for layout to resolve.
  it 'flips a transform whose matrix cannot be decomposed' do
    s = page('<div id="a"></div><div id="b"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const at = (el, time) => {
          const anim = el.animate({transform: ['matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)', 'matrix(3, 0, 0, 3, 0, 0)']},
                                  {duration: 1000, fill: 'forwards'});
          anim.pause();
          anim.currentTime = time;
          return getComputedStyle(el).transform;
        };
        return [at(a, 300), at(b, 600)];
      })()
    JS
    expect(read).to eq(['matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)', 'matrix(3, 0, 0, 3, 0, 0)'])
  end

  # A restyle that leaves an element's animations as they were — a `color` change, which its keyframes are computed
  # again for — tells the JS side nothing: what it caches of every element stays (the report is what a CSS animation
  # made or let go, or new keyframes, owe).
  it 'reports no change of animated properties for a restyle that leaves the animations' do
    s = page('<div id="a" style="animation: fade 100s linear"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        getComputedStyle(a).marginLeft;
        const now = __virtualNow();
        const before = __dom.styleFlush(now);
        a.style.color = 'red';
        const color = __dom.styleFlush(now);
        a.style.animationName = 'widen';
        const renamed = __dom.styleFlush(now);
        return [before ?? null, color ?? null, (renamed || []).length];
      })()
    JS
    expect(read).to eq([nil, nil, 1])
  end

  # `display` in `@keyframes` animates (css-display-4), holding the value that is not `none` between the ends.
  it 'animates display from a rule' do
    s = page('<div id="a" style="display: inline; animation: shown 100s -50s linear paused"></div>',
             '@keyframes shown { from { display: none } to { display: block } }')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('a')).display")).to eq('block')
  end

  # `getAnimations({subtree: true})` reports its pseudo-elements' and descendants' animations too, in composite order.
  it 'reports a subtree' do
    s = page('<div id="p" style="animation: fade 100s"><span id="c" style="animation: widen 100s"></span></div>',
             '#p::after { content: "x"; animation: fade 100s }')
    read = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p');
        return [p.getAnimations().length,
                p.getAnimations({subtree: true}).map((a) => a.animationName + (a.effect.pseudoElement || '') + ':' + a.effect.target.id)];
      })()
    JS
    expect(read).to eq([1, ['fade:p', 'fade::after:p', 'widen:c']])
  end

  # `finish` events due together go out in composite order: a CSS animation before a script's, whichever was made
  # first.
  it 'dispatches the finish events due together in composite order' do
    s = page('<div id="a"></div>')
    s.execute_script(<<~JS)
      (async () => {
        const a = document.getElementById('a');
        const script = a.animate({opacity: [1, 0]}, 1000);
        a.style.animation = 'widen 1s';
        const css = a.getAnimations()[0];
        for (const [anim, name] of [[script, 'script'], [css, 'css']]) {
          anim.onfinish = () => window.log.push(name);
        }
        await css.ready;
        css.startTime = script.startTime;
      })();
    JS
    expect(drain(s, 16).grep_v(/:/)).to eq(%w[css script])
  end

  # An element an animation's effect leaves is cacheable again, and an effect given back is a value the JS side's
  # layout (which resolves `left`) reads again.
  it 'reads a layout value again when an effect is taken away and given back' do
    s = page('<div id="a"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('a');
        const animation = a.animate({left: ['100px', '100px']}, {fill: 'forwards'});
        const effect = animation.effect;
        const read = [getComputedStyle(a).left];
        animation.effect = null;
        read.push(getComputedStyle(a).left);
        animation.effect = effect;
        read.push(getComputedStyle(a).left);
        return read;
      })()
    JS
    expect(read).to eq(%w[100px auto 100px])
  end

  # A restyle computes an animation's keyframes again where what they refer to moved: its own font for an `em`, and
  # the viewport for a `vw` — which moves nothing of the element's own style.
  it 'computes the keyframes again where what they refer to moved' do
    # (Without the verify mode, which parses every element's style attribute again and so moves its rules each time.)
    ENV['CSIM_STYLE_VERIFY'] = '0'
    s = page('<div id="c" style="font-size: 10px"></div>')
    s.current_window.resize_to(1000, 600)
    s.execute_script("document.getElementById('c').animate({marginLeft: ['2em', '2em'], paddingLeft: ['10vw', '10vw']}, 100000)")
    read = s.evaluate_script(<<~JS)
      (() => {
        const c = document.getElementById('c');
        const read = [getComputedStyle(c).marginLeft, getComputedStyle(c).paddingLeft];
        c.style.fontSize = '20px';
        read.push(getComputedStyle(c).marginLeft);
        return read;
      })()
    JS
    s.current_window.resize_to(500, 600)
    read << s.evaluate_script("getComputedStyle(document.getElementById('c')).paddingLeft")
    expect(read).to eq(%w[20px 100px 40px 50px])
  end

  # Keyframes set to another property reach the JS side's layout, which resolves it — though the element was animated
  # (and its values uncacheable) already.
  it 'lays out the property new keyframes animate' do
    s = page('<div id="b"></div>')
    read = s.evaluate_script(<<~JS)
      (() => {
        const b = document.getElementById('b');
        const x = b.animate({marginLeft: ['5px', '5px']}, 100000);
        const read = [getComputedStyle(b).marginLeft, getComputedStyle(b).paddingLeft];
        x.effect.setKeyframes({paddingLeft: ['7px', '7px']});
        read.push(getComputedStyle(b).marginLeft, getComputedStyle(b).paddingLeft);
        return read;
      })()
    JS
    expect(read).to eq(%w[5px 0px 0px 7px])
  end

  # …and where the style it inherits from moved: a neutral keyframe stands on a base value its own style inherits,
  # which a change of its parent moves without moving its own rules or font.
  it 'computes the keyframes again when the style they inherit from moves' do
    ENV['CSIM_STYLE_VERIFY'] = '0'
    s = page('<div id="p" style="padding-left: 0px"><div id="c" style="padding-left: inherit; animation: pad 100s -50s linear paused"></div></div>',
             '@keyframes pad { to { padding-left: 100px } }')
    read = s.evaluate_script(<<~JS)
      (() => {
        const p = document.getElementById('p'), c = document.getElementById('c');
        const read = [getComputedStyle(c).paddingLeft];
        p.style.paddingLeft = '50px';
        read.push(getComputedStyle(c).paddingLeft);
        return read;
      })()
    JS
    expect(read).to eq(%w[50px 75px])
  end

  # A property an element's animations newly set reaches the JS side's layout, whatever was animated there already and
  # whatever made the change: a script's second animation, or a state (`:hover`) that switches a CSS one.
  it 'lays out a property an animated element newly animates' do
    s = page('<div id="p"><div id="c"></div></div>',
             '@keyframes shift { from { margin-left: 30px } to { margin-left: 30px } }' \
             '#c { animation: fade 100s paused } #p:hover #c { animation-name: shift }')
    read = s.evaluate_script(<<~JS)
      (() => {
        const c = document.getElementById('c');
        const read = [getComputedStyle(c).marginLeft, c.getBoundingClientRect().left];
        c.animate({paddingLeft: ['7px', '7px']}, 100000);
        read.push(getComputedStyle(c).paddingLeft);
        return read;
      })()
    JS
    s.find('#p').hover
    read << s.evaluate_script("getComputedStyle(document.getElementById('c')).marginLeft")
    read << s.evaluate_script("document.getElementById('c').getBoundingClientRect().left")
    expect(read).to eq(['0px', 8, '7px', '30px', 38])
  end

  # ── CSS transitions as the model's own objects ──
  # A CSS transition is a `CSSTransition` naming its property, before the CSS animations in composite order, and the
  # object its events carry.
  it 'is a CSSTransition the page can hold' do
    s = page('<div id="a" style="transition: opacity 100s linear; animation: widen 100s"></div>')
    s.execute_script(<<~JS)
      const a = document.getElementById('a');
      getComputedStyle(a).opacity;
      a.addEventListener('transitionrun', (e) => { window.carried = e.animation === a.getAnimations()[0]; });
      a.style.opacity = '0';
    JS
    drain(s, 3)
    read = s.evaluate_script(<<~JS)
      (() => {
        const list = document.getElementById('a').getAnimations();
        return [list.map((x) => x.constructor.name).join(), list[0].transitionProperty, window.carried];
      })()
    JS
    expect(read).to eq(['CSSTransition,CSSAnimation', 'opacity', true])
  end

  # A style change an animation frame callback makes starts its transitions in that frame's style update, so the
  # events they owe are the next frame's, sent before its callbacks (HTML "update the rendering").
  it 'sends the events of a transition a frame callback started before the next frame callback' do
    s = page('<div id="a" style="transition: opacity 3s -1s linear"></div>')
    s.execute_script(<<~JS)
      window.seen = null;
      document.body.offsetLeft;
      requestAnimationFrame(() => {
        document.getElementById('a').style.opacity = '0';
        requestAnimationFrame(() => { window.seen = window.log.slice(); });
      });
    JS
    drain(s, 4)
    expect(s.evaluate_script('window.seen')).to eq(%w[transitionrun:opacity:1:a transitionstart:opacity:1:a])
  end

  # A pseudo-element whose element stops being rendered stops too: its transitions and animations are canceled, and
  # none starts — its styles are what they were, but it generates no box.
  it "cancels a pseudo-element's transitions and animations when its element is not rendered" do
    s = page('<div id="a"></div><div id="b"></div>',
             '#a::before { content: "x"; opacity: 0; transition: opacity 1s linear } #a.on::before { opacity: 1 }' \
             '#b::after { content: "y"; animation: fade 1s linear }')
    s.execute_script(<<~JS)
      getComputedStyle(document.getElementById('a'), '::before').opacity;
      document.getElementById('a').classList.add('on');
    JS
    drain(s, 3)
    s.execute_script(<<~JS)
      const a = document.getElementById('a');
      a.classList.remove('on');
      a.style.display = 'none';
      document.getElementById('b').style.display = 'none';
    JS
    events = drain(s, 12)
    expect(events.grep(/cancel/).map {|e| e.split(':').first }.sort).to eq(%w[animationcancel transitioncancel])
    expect(events.grep(/end:/)).to eq([])
    expect(s.evaluate_script('document.getAnimations().length')).to eq(0)
  end

  # A registered custom property whose syntax interpolates transitions without `allow-discrete`.
  it 'transitions a registered custom property' do
    s = page('<div id="a" style="transition: --x 1s linear"></div>',
             '@property --x { syntax: "<length>"; inherits: false; initial-value: 0px }')
    s.execute_script(<<~JS)
      const a = document.getElementById('a');
      getComputedStyle(a).getPropertyValue('--x');
      a.style.setProperty('--x', '100px');
    JS
    values = 6.times.map { s.evaluate_script("getComputedStyle(document.getElementById('a')).getPropertyValue('--x')") }
    expect(values.map(&:to_f).uniq.size).to be > 2
  end
end
