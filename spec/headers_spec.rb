# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Headers, generated from its IDL: its arguments converted (a ByteString, a HeadersInit), its brand checked, its pair
# iterator Web IDL's — and its header list, names first given and guard, slots no page can reach. The figures are
# headless Chrome's.
RSpec.describe 'Headers' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><iframe></iframe>']] })
    s.visit('/')
    s
  }

  it "throws Chrome's errors" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.message; } };
        return [
          error(() => new Headers().append('a b', 'x')),
          error(() => new Headers().append('a', 'x\\ny')),
          error(() => new Headers().append('a', '\\u0100')),
          error(() => new Headers(null)),
          error(() => new Headers([1])),
          error(() => new Headers().get()),
          error(() => Response.error().headers.delete('a')),
          error(() => new Headers().entries().next.call({}))
        ];
      })()
    JS
    expect(got).to eq([
      "Failed to execute 'append' on 'Headers': Invalid name",
      "Failed to execute 'append' on 'Headers': Invalid value",
      "Failed to execute 'append' on 'Headers': String contains non ISO-8859-1 code point.",
      "Failed to construct 'Headers': The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.",
      "Failed to construct 'Headers': The provided value cannot be converted to a sequence.",
      "Failed to execute 'get' on 'Headers': 1 argument required, but only 0 present.",
      "Failed to execute 'delete' on 'Headers': Headers are immutable",
      'Illegal invocation'
    ])
  end

  it 'iterates sorted and combined, each set-cookie its own, as a Headers Iterator' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const h = new Headers([['B', '1'], ['a', '2'], ['Set-Cookie', 'x'], ['set-cookie', 'y']]);
        return [[...h], Object.prototype.toString.call(h.entries()), Headers.length];
      })()
    JS
    expect(got).to eq([[%w[a 2], %w[b 1], %w[set-cookie x], %w[set-cookie y]], '[object Headers Iterator]', 0])
  end

  it "takes another realm's Headers as a Request's, and refuses a null one" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const headers = document.querySelector('iframe').contentWindow.eval('new Headers([["a", "1"]])');
        let refused;
        try { new Request('/x', {headers: null}); } catch (e) { refused = e.constructor.name; }
        return [new Request('/x', {headers}).headers.get('a'), refused];
      })()
    JS
    expect(got).to eq(['1', 'TypeError'])
  end
end
