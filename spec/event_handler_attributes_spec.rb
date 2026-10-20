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

  # HTML "getting the current value of the event handler": none in a document scripting is disabled for — a
  # DOMParser's, a template's contents' — until the element is in one with a browsing context.
  it 'compiles no inline handler in a document with no browsing context' do
    got = session.evaluate_script(<<~JS)
      (() => {
        window.hits = [];
        const d = new DOMParser().parseFromString('<body onclick="hits.push(1)"><div onclick="hits.push(2)"></div>', 'text/html');
        d.body.dispatchEvent(new Event('click'));
        const tp = document.createElement('template');
        tp.innerHTML = '<i onclick="hits.push(3)"></i>';
        tp.content.firstChild.dispatchEvent(new Event('click'));
        const adopted = document.adoptNode(d.querySelector('div'));
        adopted.dispatchEvent(new Event('click'));
        return [d.body.onclick, tp.content.firstChild.onclick, typeof adopted.onclick, hits];
      })()
    JS
    expect(got).to eq([nil, nil, 'function', [2]])
  end

  # …which asks of a handler not yet compiled alone: one compiled stays, wherever its element goes (Chrome 155 alike).
  it 'keeps a compiled inline handler in a document with no browsing context' do
    got = session.evaluate_script(<<~JS)
      (() => {
        window.hits = [];
        const d = document.body.appendChild(document.createElement('div'));
        d.setAttribute('onclick', 'hits.push("live")');
        d.click();
        new DOMParser().parseFromString('<p>', 'text/html').adoptNode(d);
        d.click();
        return [typeof d.onclick, hits];
      })()
    JS
    expect(got).to eq(['function', %w[live live]])
  end

  # A body adopted from or into a frame's document forwards to its new document's Window, the handler that Window's own
  # (Chrome 155 alike).
  it "forwards an adopted body's handlers to its document's Window" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body><iframe srcdoc="<p>"></iframe>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const run = () => {
        const fd = frames[0].document, fw = frames[0];
        const b = fd.createElement('body');
        document.adoptNode(b);
        b.setAttribute('onpageshow', 'x');
        const b2 = document.createElement('body');
        fd.adoptNode(b2);
        b2.setAttribute('onhashchange', 'y');
        done([typeof window.onpageshow, typeof fw.onpageshow, typeof window.onhashchange, typeof fw.onhashchange]);
      };
      frames[0].document.readyState === 'complete' ? run() : document.querySelector('iframe').onload = run;
    JS
    expect(got).to eq(%w[function object object function])
  end
end
