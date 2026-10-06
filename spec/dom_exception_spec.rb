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
end
