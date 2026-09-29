# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The style engine (stylo over the arena) restyles only what a change reached — the snapshots and hints its change
# hooks leave, the selector flags matching left on a parent, the elements whose state moved. Each example makes one
# kind of change and reads a value it moved; CSIM_STYLE_VERIFY holds every such restyle against styling the whole
# document again, and a read throws when the two differ.
RSpec.describe 'style engine invalidation' do
  around do |example|
    saved = ENV.values_at('CSIM_STYLO', 'CSIM_STYLE_VERIFY')
    ENV['CSIM_STYLO'] = '1'
    ENV['CSIM_STYLE_VERIFY'] = '1'
    example.run
  ensure
    ENV['CSIM_STYLO'], ENV['CSIM_STYLE_VERIFY'] = saved
  end

  CSS = <<~CSS
    .on .kid { color: rgb(1, 2, 3); }
    #target { color: rgb(4, 5, 6); }
    li:nth-child(2) { color: rgb(7, 8, 9); }
    .a + .b { color: rgb(10, 11, 12); }
    p:empty { color: rgb(13, 14, 15); }
    input:checked + span { color: rgb(16, 17, 18); }
    x-el:state(big) { color: rgb(19, 20, 21); }
    x-el:state(big) + span { color: rgb(22, 23, 24); }
    .moved { color: rgb(25, 26, 27); }
    #box .moved { color: rgb(28, 29, 30); }
    li:first-child { font-style: italic; }
  CSS

  def visit(body)
    html = "<!DOCTYPE html><html><head><style>#{CSS}</style></head><body>#{body}</body></html>"
    app = ->(_env) { [200, {'content-type' => 'text/html'}, [html]] }
    session = simulated_session(app)
    session.visit '/'
    session
  end

  def color(session, selector, script = nil)
    session.evaluate_script(<<~JS)
      (() => {
        getComputedStyle(document.body).color;
        #{script}
        return getComputedStyle(document.querySelector(#{selector.to_json})).color;
      })()
    JS
  end

  it 'restyles the descendants a class on an ancestor reaches' do
    s = visit('<div id="p"><span class="kid">k</span></div>')
    expect(color(s, '.kid', 'document.getElementById("p").className = "on";')).to eq('rgb(1, 2, 3)')
  end

  it 'restyles an element whose id changed' do
    s = visit('<div id="x">x</div>')
    expect(color(s, 'div', 'document.getElementById("x").id = "target";')).to eq('rgb(4, 5, 6)')
  end

  it 'restyles the siblings a structural pseudo-class reaches when a child is inserted' do
    s = visit('<ul><li id="one">1</li><li id="two">2</li></ul>')
    script = 'document.querySelector("ul").prepend(document.createElement("li"));'
    expect(color(s, '#one', script)).to eq('rgb(7, 8, 9)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("two")).color')).to eq('rgb(0, 0, 0)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("one")).fontStyle')).to eq('normal')
  end

  it 'restyles the element a sibling combinator reaches when its sibling changes' do
    s = visit('<i id="first">1</i><i id="second" class="b">2</i>')
    expect(color(s, '#second', 'document.getElementById("first").className = "a";')).to eq('rgb(10, 11, 12)')
  end

  # A text node with no data is no content (Selectors' `:empty`, and Chrome): emptying it empties the parent.
  it 'restyles a parent whose emptiness changed with its text' do
    s = visit('<p id="p">text</p>')
    expect(color(s, '#p', 'document.getElementById("p").firstChild.data = "";')).to eq('rgb(13, 14, 15)')
    expect(color(s, '#p', 'document.getElementById("p").append("more");')).to eq('rgb(0, 0, 0)')
  end

  it 'restyles what an element state reaches' do
    s = visit('<input type="checkbox" id="c"><span id="s">s</span>')
    expect(color(s, '#s', 'document.getElementById("c").checked = true;')).to eq('rgb(16, 17, 18)')
  end

  it 'restyles a style attribute' do
    s = visit('<div id="d">d</div>')
    expect(color(s, '#d', 'document.getElementById("d").style.color = "rgb(31, 32, 33)";')).to eq('rgb(31, 32, 33)')
  end

  it 'restyles a presentational hint' do
    s = visit('<font id="f">f</font>')
    expect(color(s, '#f', 'document.getElementById("f").setAttribute("color", "#ff0000");')).to eq('rgb(255, 0, 0)')
  end

  it 'restyles what a custom state reaches' do
    s = visit('<x-el id="x">x</x-el><span id="after">a</span>')
    script = <<~JS
      customElements.define('x-el', class extends HTMLElement {
        constructor() { super(); this.i = this.attachInternals(); }
      });
      getComputedStyle(document.getElementById('x')).color;
      document.getElementById('x').i.states.add('big');
    JS
    expect(color(s, '#x', script)).to eq('rgb(19, 20, 21)')
    expect(s.evaluate_script('getComputedStyle(document.getElementById("after")).color')).to eq('rgb(22, 23, 24)')
  end

  it 'restyles an element moved to where other rules match it' do
    s = visit('<div id="box"></div><span class="moved" id="m">m</span>')
    expect(color(s, '#m', 'document.getElementById("box").append(document.getElementById("m"));')).to eq('rgb(28, 29, 30)')
  end
end
