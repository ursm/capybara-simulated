# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A click has ONE activation target (DOM dispatch: "If isActivationEvent is true, event's bubbles attribute is true,
# activationTarget is null, and parent has activation behavior, then set activationTarget to parent") — the engine's
# (element_state.rs `activation_target`) — and only its activation behaviour runs: the link is not followed for a click
# that does not bubble on what is inside it, nor past an element with activation behaviour of its own — a checkbox, a
# label with a control, a details' summary (Chrome alike) — and, as HTML gives every input and button one ("The
# activation behavior for input elements are these steps", "A button element element's activation behavior given event
# is"), nor past a text input or a button: there Chrome and Firefox follow the link, departing from the text.
RSpec.describe 'the activation target of a click' do
  let(:page_html) {
    <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body>
      <a href="#s1"><span id=s1>x</span></a>
      <a href="#i2"><input id=i2></a>
      <a href="#c4"><input type=checkbox id=c4></a>
      <a href="#lab"><label id=lab>lbl<input type=checkbox id=lc></label></a>
      <a href="#sm"><details><summary id=sm>s</summary>body</details></a>
      <a href="#b"><button type=button id=b>b</button></a>
    HTML
  }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  it 'follows the link only where it is the click\'s activation target' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const click = (id, bubbles) => {
          location.hash = '';
          document.getElementById(id).dispatchEvent(new MouseEvent('click', {bubbles, cancelable: true}));
          return id + location.hash;
        };
        return [click('s1', false), click('i2', true), click('c4', true), click('lab', true), click('sm', true), click('b', true),
                document.getElementById('c4').checked, document.getElementById('lc').checked,
                document.getElementById('sm').parentNode.open];
      })()
    JS
    expect(got).to eq(['s1', 'i2', 'c4', 'lab', 'sm', 'b', true, true, true])
  end

  # The target's event path goes up through slots and, for a composed click, out of its shadow tree to the host — a
  # host's child no slot takes straight to the host — and the link the activation target is followed, an SVG one's by
  # its resolved `href` (Chrome and Firefox, all but the last).
  it 'finds the activation target along the event path, and follows an SVG link' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const click = (el, composed) => {
          location.hash = '';
          el.dispatchEvent(new MouseEvent('click', {bubbles: true, composed, cancelable: true}));
          return location.hash;
        };
        const outer = document.body.appendChild(document.createElement('a'));
        outer.href = '#out';
        const host = outer.appendChild(document.createElement('span'));
        const inner = host.attachShadow({mode: 'open'}).appendChild(document.createElement('b'));
        const shadowLink = document.body.appendChild(document.createElement('div'));
        shadowLink.attachShadow({mode: 'open'}).innerHTML = '<a href="#slot"><slot></slot></a>';
        const slotted = shadowLink.appendChild(document.createElement('i'));
        const unslottedLink = document.body.appendChild(document.createElement('a'));
        unslottedLink.href = '#unslotted';
        const unslottedHost = unslottedLink.appendChild(document.createElement('span'));
        unslottedHost.attachShadow({mode: 'open'}).innerHTML = '<b>no slot</b>';
        const unslotted = unslottedHost.appendChild(document.createElement('i'));
        const svg = document.body.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
        svg.innerHTML = '<a href="#svg"><text id="t">t</text></a>';
        return [click(inner, true), click(inner, false), click(slotted, true), click(unslotted, false),
                click(svg.querySelector('text'), true)];
      })()
    JS
    expect(got).to eq(['#out', '', '#slot', '#unslotted', '#svg'])
  end
end

RSpec.describe 'a click inside a summary' do
  let(:page_html) {
    <<~HTML
      <!DOCTYPE html><meta charset=utf-8><body>
      <details><summary id=sm><span id=plain>s</span><select id=sel><option>o</select><label id=lab>l</label></summary>body</details>
    HTML
  }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  # A summary does not open its details for a click that came through interactive content inside it (Chrome and
  # Firefox: WPT the-summary-element/interactive-content).
  it 'opens its details only for a click on what is not interactive content' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['plain', 'sel', 'lab'].map((id) => {
        const details = document.querySelector('details');
        details.open = false;
        document.getElementById(id).dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        return details.open;
      })
    JS
    expect(got).to eq([true, false, false])
  end
end
