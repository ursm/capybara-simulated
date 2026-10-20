# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML's event handler content attributes (§8.1.8.1-2), the engine's (event_handlers.rs, from the IDL's event handler
# attributes): an HTML, SVG or MathML element's GlobalEventHandlers ones; none of an element in no such namespace, nor a
# WindowEventHandlers one on anything but a body or frameset, which forward those — and blur, error, focus, load,
# resize and scroll — to their Window; the legacy WebKit-prefixed four listening for their camel-case types.
RSpec.describe 'Event handler content attributes' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/' }

  it 'activates the handlers an element has, forwarding a body\'s to its Window' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const log = [];
        window.__hit = (what) => log.push(what);
        const fire = (target, type) => target.dispatchEvent(new Event(type));
        const div = document.body.appendChild(document.createElement('div'));
        div.setAttribute('onclick', '__hit("div click")');
        div.setAttribute('onstorage', '__hit("div storage")');
        fire(div, 'click');
        fire(div, 'storage');
        const svg = document.body.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
        svg.setAttribute('onclick', '__hit("svg click")');
        fire(svg, 'click');
        const other = document.body.appendChild(document.createElementNS('urn:x', 'x'));
        other.setAttribute('onclick', '__hit("other click")');
        fire(other, 'click');
        document.body.setAttribute('onstorage', '__hit("window storage")');
        document.body.setAttribute('onfocus', '__hit("window focus")');
        document.body.setAttribute('onclick', '__hit("body click")');
        fire(window, 'storage');
        fire(window, 'focus');
        fire(document.body, 'click');
        div.setAttribute('onwebkitanimationend', '__hit("webkit")');
        fire(div, 'webkitAnimationEnd');
        fire(div, 'webkitanimationend');
        return [log, typeof window.onstorage, document.body.onstorage === window.onstorage, div.onstorage];
      })()
    JS
    expect(got).to eq([['div click', 'svg click', 'window storage', 'window focus', 'body click', 'webkit'], 'function', true, nil])
  end
end
