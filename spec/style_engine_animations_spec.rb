# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSS animations and transitions in the style engine: stylo's model runs them, the page's clock moves them (an
# animation-only restyle each time it does), and a rendering update fires the events the phases they moved through
# since the last one owe. Each example drives the clock the way a page does — a pending interval keeps it stepping,
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

  # A value an element inherits from its parent's transition is that transition's, arriving through inheritance: the
  # element transitioning the same property starts no run of its own, frame after frame (css-transitions §3).
  it 'starts no transition under a parent transitioning the same property' do
    s = page(
      '<div id="p" class="c"><div id="k" class="kid">x</div></div>',
      '.c { color: rgb(0, 0, 0); transition: color 300ms linear } .c.to { color: rgb(100, 100, 100) }
       .kid { color: inherit; transition: color 300ms linear }'
    )
    s.execute_script("getComputedStyle(document.getElementById('k')).color; document.getElementById('p').classList.add('to')")
    expect(drain(s).grep(/:k$/)).to eq([])
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
end
