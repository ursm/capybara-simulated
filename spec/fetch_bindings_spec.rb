# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Request, Response and Body, generated from their IDL: fetch() constructs a Request before anything else, a
# RequestInit / ResponseInit is converted once by its dictionary, a Response's internal form no page object can take,
# and a body reads through this realm's own FormData / Blob / decoder whatever a page does to the globals. The figures
# are headless Chrome's.
RSpec.describe 'Fetch bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']] })
    s.visit('/')
    s
  }

  it "throws Chrome's errors" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const U = 'http://x/';
        const used = new Request(U, {method: 'POST', body: 'x'});
        used.text();
        const locked = new ReadableStream();
        locked.getReader();
        return [
          error(() => new Request(U, {mode: 'navigate'})),
          error(() => new Request(U, {method: 'a b'})),
          error(() => new Request(U, {method: 'CONNECT'})),
          error(() => new Request(U, {mode: 'no-cors', method: 'PUT'})),
          error(() => new Request(U, {cache: 'only-if-cached'})),
          error(() => new Request(U, {referrer: 'http://['})),
          error(() => new Request('http://a:b@x/')),
          error(() => new Request(U, {method: 'POST', body: new ReadableStream()})),
          error(() => new Request(U, {method: 'POST', body: new ReadableStream(), duplex: 'half', keepalive: true})),
          error(() => new Request(used)),
          error(() => used.clone()),
          error(() => new Request(U, {headers: null})),
          error(() => new Response('', {status: 100})),
          error(() => new Response('x', {status: 204})),
          error(() => new Response(locked)),
          error(() => Response.redirect('http://[')),
          error(() => Response.json(Symbol()))
        ];
      })()
    JS
    expect(got).to eq([
      "TypeError: Failed to construct 'Request': Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.",
      "TypeError: Failed to construct 'Request': 'a b' is not a valid HTTP method.",
      "TypeError: Failed to construct 'Request': 'CONNECT' HTTP method is unsupported.",
      "TypeError: Failed to construct 'Request': 'PUT' is unsupported in no-cors mode.",
      "TypeError: Failed to construct 'Request': 'only-if-cached' can be set only with 'same-origin' mode",
      "TypeError: Failed to construct 'Request': Referrer 'http://[' is not a valid URL.",
      "TypeError: Failed to construct 'Request': Request cannot be constructed from a URL that includes credentials: http://a:b@x/",
      "TypeError: Failed to construct 'Request': The `duplex` member must be specified for a request with a streaming body",
      "TypeError: Failed to construct 'Request': Keepalive request cannot have a ReadableStream body.",
      "TypeError: Failed to construct 'Request': Cannot construct a Request with a Request object that has already been used.",
      "TypeError: Failed to execute 'clone' on 'Request': Request body is already used",
      "TypeError: Failed to construct 'Request': Failed to read the 'headers' property from 'RequestInit': The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.",
      "RangeError: Failed to construct 'Response': The status provided (100) is outside the range [200, 599].",
      "TypeError: Failed to construct 'Response': Response with null body status cannot have body",
      "TypeError: Failed to construct 'Response': Response body object should not be disturbed or locked",
      "TypeError: Failed to execute 'redirect' on 'Response': Failed to parse URL from http://[",
      "TypeError: Failed to execute 'json' on 'Response': The data is not JSON serializable"
    ])
  end

  it 'constructs the Request first, converts an init once, and takes no page object for its internal form' do
    session.execute_script(<<~JS)
      (async () => {
        const err = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.name + ': ' + e.message; } };
        const out = [];
        const c = new AbortController();
        c.abort();
        out.push(await err(fetch('http://x/', {signal: c.signal, headers: {'a b': '1'}})));
        const post = new Request('http://x/', {method: 'POST', body: 'x'});
        out.push(await err(fetch(post, {headers: {'a b': '1'}})), post.bodyUsed);
        const r = new Response({status: 201, body: 'zz'});
        out.push(r.status, await r.text());
        out.push(Response.json(1, Object.create({status: 201})).status);
        let gets = 0;
        new Response('x', new Proxy({}, {get() { gets++; return undefined; }}));
        out.push(gets);
        window.got = out;
      })();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq([
      "TypeError: Failed to execute 'fetch' on 'Window': Invalid name",
      "TypeError: Failed to execute 'fetch' on 'Window': Invalid name",
      false, 200, '[object Object]', 201, 3
    ])
  end

  it 'reads a body through its own FormData, Blob and decoder, whatever a page does to the globals' do
    session.execute_script(<<~JS)
      (async () => {
        window.FormData = window.URLSearchParams = window.TextDecoder = window.File = window.Blob = function () { throw new Error('page'); };
        const fd = await new Response('a=1&b=%C3%A9', {headers: {'content-type': 'application/x-www-form-urlencoded'}}).formData();
        window.got = [[...fd].join('|'), Object.prototype.toString.call(await new Response('x').blob()), await new Response('\\ufeffé').text()];
      })();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq(['a,1|b,é', '[object Blob]', 'é'])
  end
end
