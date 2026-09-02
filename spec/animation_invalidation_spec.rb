# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Starting an animation has to reach two things: the element's box, and any value of it the
# declared-value memo is already holding. The second is what the document-wide cascade re-key in
# `Animation._invalidate` exists for — and it is only owed when the memo actually holds something
# for that element, which on the shape that matters (a list animating each row in as it is added)
# it never does.
RSpec.describe 'starting an animation invalidates what it has to' do
  def page_with(body, css: '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><html><head><style>
          body { margin: 0 }
          .b { width: 100px; height: 50px; background: #ccc }
          #{css}
        </style></head><body>#{body}</body></html>
      HTML
    })
    session.visit '/'
    session
  end

  def x_of(session, id)
    session.evaluate_script("Math.round(document.getElementById(#{id.to_json}).getBoundingClientRect().x)")
  end

  # THE discriminating case: the property the animation will move has to have been READ before it
  # starts, or the memo holds nothing stale and skipping the re-key is free either way. A
  # `getBoundingClientRect` is not enough — with no transform declared anywhere the gate keeps
  # layout from ever reading `transform`, so nothing is cached for it. Reading the computed value
  # is what fills the memo, and it is exactly the shape a page that measures before it animates has.
  it 'follows an animation started after the property has been READ' do
    s = page_with('<div class=b id=t></div>')
    expect(s.evaluate_script("getComputedStyle(document.getElementById('t')).transform")).to eq('none')
    s.execute_script(<<~JS)
      document.getElementById('t').animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }],
        { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
      );
    JS
    expect(s.evaluate_script("getComputedStyle(document.getElementById('t')).transform"))
      .to eq('matrix(1, 0, 0, 1, 100, 0)')
    expect(x_of(s, 't')).to eq(100)
  end

  it 'follows an animation started after the element has been measured' do
    s = page_with('<div class=b id=t></div>')
    expect(x_of(s, 't')).to eq(0)
    s.execute_script(<<~JS)
      document.getElementById('t').animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }],
        { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
      );
    JS
    expect(x_of(s, 't')).to eq(100)
  end

  # …and one whose target is brand new, which is the case that pays nothing.
  it 'follows an animation started on an element that has never been measured' do
    s = page_with('')
    s.execute_script(<<~JS)
      const d = document.createElement('div');
      d.className = 'b';
      d.id = 't';
      document.body.appendChild(d);
      d.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }],
        { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
      );
    JS
    expect(x_of(s, 't')).to eq(100)
  end

  # A SIBLING that was measured before must not be disturbed by the new element's animation, and a
  # sibling measured before must still see its own animation when it starts one.
  it 'keeps each element on its own animation' do
    s = page_with('<div class=b id=t></div><div class=b id=u></div>')
    expect(x_of(s, 't')).to eq(0)
    expect(x_of(s, 'u')).to eq(0)
    s.execute_script(<<~JS)
      for (const id of ['t', 'u']) {
        document.getElementById(id).animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(' + (id === 't' ? 200 : 400) + 'px)' }],
          { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
        );
      }
    JS
    expect(x_of(s, 't')).to eq(100)
    expect(x_of(s, 'u')).to eq(200)
  end

  # The re-key latch is per (animation, TARGET), not per animation. Each of these three had the
  # element's value READ while it was not animating — which is what puts something stale in the memo
  # — and each Chrome-measured on the same markup.
  #
  # The rule that matches NOTHING is load-bearing: without a `transform` declared somewhere the
  # layout gate never reads the property, so nothing is cached for it and every shape below passes
  # by accident. (An animation declares it too, but only for the element it targets.)
  MATCHES_NOTHING = '#nothing-matches-this { transform: translateX(1px) }'

  def midpoint(session, id, to)
    session.execute_script(<<~JS)
      globalThis.__a = document.getElementById(#{id.to_json}).animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(#{to})' }],
        { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' }
      );
    JS
  end

  def transform_of(session, id)
    session.evaluate_script("getComputedStyle(document.getElementById(#{id.to_json})).transform")
  end

  it 'follows an effect retargeted onto an element that was already read' do
    s = page_with('<div class=b id=t></div><div class=b id=u></div>', css: MATCHES_NOTHING)
    expect(transform_of(s, 'u')).to eq('none')         # …and this is what fills u's memo
    midpoint(s, 't', '400px')
    s.execute_script("globalThis.__a.effect.target = document.getElementById('u')")
    expect(transform_of(s, 'u')).to eq('matrix(1, 0, 0, 1, 200, 0)')
    expect(x_of(s, 'u')).to eq(200)
  end

  it 'follows a SECOND animation started after the first was read' do
    s = page_with('<div class=b id=t></div>', css: MATCHES_NOTHING)
    midpoint(s, 't', '200px')
    expect(x_of(s, 't')).to eq(100)                    # the first one, and the read that warms it
    midpoint(s, 't', '600px')
    expect(transform_of(s, 't')).to eq('matrix(1, 0, 0, 1, 300, 0)')
    expect(x_of(s, 't')).to eq(300)
  end

  it 'follows an animation cancelled, read, and played again' do
    s = page_with('<div class=b id=t></div>', css: MATCHES_NOTHING)
    midpoint(s, 't', '400px')
    s.execute_script('globalThis.__a.cancel()')
    expect(transform_of(s, 't')).to eq('none')         # cacheable again — and cached
    s.execute_script('globalThis.__a.play()')
    expect(transform_of(s, 't')).to eq('matrix(1, 0, 0, 1, 200, 0)')
    expect(x_of(s, 't')).to eq(200)
  end

  # `animationsOn` is an index by target now, and `play()` after `cancel()` puts an animation back
  # at the end of the insertion-ordered live set — so composite order has to come from the
  # sequence, not from that iteration order. Two animations of the same property: the LATER one wins.
  it 'composes two animations on one element in creation order, across a cancel and replay' do
    s = page_with('<div class=b id=t></div>')
    s.execute_script(<<~JS)
      const d = document.getElementById('t');
      const opts = { easing: 'cubic-bezier(0,1,1,0)', duration: 1000, delay: -500, fill: 'both' };
      globalThis.__first  = d.animate([{ transform: 'translateX(0)' },   { transform: 'translateX(200px)' }], opts);
      globalThis.__second = d.animate([{ transform: 'translateX(0)' },   { transform: 'translateX(400px)' }], opts);
    JS
    expect(x_of(s, 't')).to eq(200)                    # the second one wins
    s.execute_script('globalThis.__first.cancel(); globalThis.__first.play()')
    expect(x_of(s, 't')).to eq(200)                    # …still, though it re-entered the live set
  end
end
