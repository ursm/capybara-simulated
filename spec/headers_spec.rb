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

  it "reads a Request's init headers once, and a copy, a JSON response's or a clone's not through the iterator" do
    got = session.evaluate_script(<<~JS)
      (() => {
        let reads = 0;
        new Request('/x', {get headers() { reads++; return {a: '1'}; }});
        Headers.prototype[Symbol.iterator] = Headers.prototype.entries = function () { return [][Symbol.iterator](); };
        const req = new Request('/x', {headers: [['x-a', '1']]});
        const json = Response.json(1, {headers: [['x-a', '1']]});
        return [reads, new Request(req).headers.get('x-a'), new Request(req, {method: 'POST'}).headers.get('x-a'),
                req.clone().headers.get('x-a'), json.headers.get('content-type'), json.headers.get('x-a')];
      })()
    JS
    expect(got).to eq([1, '1', '1', '1', 'application/json', '1'])
  end

  it "copies a source Request's combined value as it is, where converting an init normalizes it" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = new Request('/x', {headers: [['a', 'x'], ['a', '']]});
        return [r.headers.get('a'), new Request(r, {method: 'POST'}).headers.get('a'), Response.json(1, {headers: r.headers}).headers.get('a')];
      })()
    JS
    expect(got).to eq(['x, ', 'x, ', 'x,'])
  end

  # (…a window V8 itself refuses, before any binding is asked, and names as `[object Window]` where Chrome's own global
  # reads `#<Window>`)
  it "refuses a structured clone with Chrome's message" do
    got = session.evaluate_script(<<~JS)
      [new Headers(), new FormData(), new AbortController(), window].map((v) => {
        try { structuredClone(v); return 'cloned'; } catch (e) { return e.name + ': ' + e.message; }
      })
    JS
    expect(got).to eq([
      "DataCloneError: Failed to execute 'structuredClone' on 'Window': Headers object could not be cloned.",
      "DataCloneError: Failed to execute 'structuredClone' on 'Window': FormData object could not be cloned.",
      "DataCloneError: Failed to execute 'structuredClone' on 'Window': AbortController object could not be cloned.",
      "DataCloneError: Failed to execute 'structuredClone' on 'Window': [object Window] could not be cloned."
    ])
  end
end
