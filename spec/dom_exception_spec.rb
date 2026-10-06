require 'capybara/simulated'
require_relative 'support/session_teardown'

# DOMException as Web IDL §3.14.1 makes it: its interface object's [[Prototype]] %Function.prototype%, its prototype's
# Error's; its name and message its own state, no data a page overwrites; and any realm's reported as an exception is,
# its place with it.
RSpec.describe 'DOMException' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset=utf-8><p>x
        <script>function hostThrow() { document.createElement('1'); }</script>
        <button onclick="document.createElement('2')">b</button>
        <iframe srcdoc="<script>boom = () => { throw new DOMException('fx', 'NotFoundError'); };</script>"></iframe>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  it 'is the interface Web IDL makes, and reports a frame’s with its place' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], e = new DOMException('m', 'AbortError');
      e.name = 'Foo';
      const shape = [Object.getPrototypeOf(DOMException) === Function.prototype, Object.getPrototypeOf(DOMException.prototype) === Error.prototype,
                     e instanceof Error, e.name, Object.prototype.toString.call(e)];
      window.addEventListener('error', (ev) => { ev.preventDefault(); done([shape, ev.message, ev.lineno > 0]); }, { once: true });
      setTimeout(() => frames[0].boom());
    JS
    expect(got).to eq([[true, true, true, 'AbortError', '[object DOMException]'], 'NotFoundError: fx', true])
  end

  # (…one a binding throws for the page's call reported where the page called it: the driver's own frames are none of
  # the page's. Its line is the script's, not yet the document's — an inline script's line offset is not given V8.)
  it "reports one a binding threw at the page's call" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      window.addEventListener('error', (ev) => { ev.preventDefault(); done([ev.message.split(':')[0], ev.filename === location.href, ev.lineno > 0]); }, { once: true });
      setTimeout(hostThrow);
    JS
    expect(got).to eq(['InvalidCharacterError', true, true])
  end

  it "reports one an event handler content attribute's code threw as the document's" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      window.addEventListener('error', (ev) => { ev.preventDefault(); done([ev.message.split(':')[0], ev.filename === location.href, ev.lineno > 0]); }, { once: true });
      setTimeout(() => document.querySelector('button').click());
    JS
    expect(got).to eq(['InvalidCharacterError', true, true])
  end
end
