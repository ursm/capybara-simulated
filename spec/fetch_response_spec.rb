# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Fetch `Response` value-type semantics: a disturbed/locked stream body is rejected at
# construction, `Response.json` throws on a non-encodable value, and a network-fetched
# response's headers are immutable.
RSpec.describe 'Fetch Response semantics' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'       then [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
        when '/data'   then [200, {'content-type' => 'application/json'}, ['{"ok":true}']]
        when '/cookie' then [200, {'content-type' => 'text/plain', 'set-cookie' => 'a=1', 'x-kept' => '1'}, ['c']]
        else                [404, {'content-type' => 'text/plain'}, ['nope']]
        end
      }
    }.to_app
  }

  before { Capybara.app = app }

  it 'rejects a disturbed or locked ReadableStream body, and Response.json rejects non-encodable data' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      const locked = new ReadableStream({start(c) { c.enqueue(new Uint8Array([1])); c.close(); }});
      locked.getReader();                                   // lock it
      JSON.stringify({
        lockedStream: err(() => new Response(locked)),      // TypeError
        okStream:     err(() => new Response(new ReadableStream({start(c) { c.close(); }}))), // no-throw
        jsonSymbol:   err(() => Response.json(Symbol('x'))), // TypeError (not encodable)
        jsonObject:   err(() => Response.json({a: 1})),      // no-throw
      });
    JS
    r = JSON.parse(out)
    expect(r['lockedStream']).to eq('TypeError')
    expect(r['okStream']).to eq('no-throw')
    expect(r['jsonSymbol']).to eq('TypeError')
    expect(r['jsonObject']).to eq('no-throw')
  end

  it 'makes a fetched response header list immutable but a constructed one mutable' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script <<~JS
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      // A constructed Response has the mutable 'response' guard.
      const built = new Response('body');
      const builtMutable = err(() => built.headers.append('x-added', 'v'));
      fetch('/data').then(res => {
        globalThis.__r = JSON.stringify({
          builtMutable,
          builtHas:     built.headers.get('x-added'),
          fetchedThrew: err(() => res.headers.append('x-added', 'v')),   // TypeError (immutable)
          fetchedHas:   res.headers.get('x-added'),                      // null
        });
      });
    JS
    # The fetch resolves on a later tick; wait for the OBSERVABLE, not the clock —
    # a fixed sleep turns a slow CI worker into a `JSON::ParserError` on nil.
    r = JSON.parse(poll_until { session.evaluate_script('globalThis.__r') })
    expect(r['builtMutable']).to eq('no-throw')
    expect(r['builtHas']).to eq('v')
    expect(r['fetchedThrew']).to eq('TypeError')
    expect(r['fetchedHas']).to be_nil
  end

  # A fetched response is a filtered one — its cookies (`Set-Cookie`, a forbidden response-header name) never script's to
  # read, as XHR's are not — set all the same.
  it "hides a fetched response's cookies, which it sets" do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script("fetch('/cookie').then((r) => { globalThis.__r = [r.headers.get('set-cookie'), r.headers.get('x-kept'), document.cookie]; })")
    expect(poll_until { session.evaluate_script('globalThis.__r') }).to eq([nil, '1', 'a=1'])
  end

  # A Response or Request another realm made is cloned in ITS realm, whichever realm's `clone` is called (Fetch "clone":
  # "in this's relevant realm"): Chrome's clone of a frame's Response by the top page's method is the frame's.
  it 'clones another realm’s Response and Request into that realm' do
    session = simulated_session(app)
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const f = document.body.appendChild(document.createElement('iframe'));
        const W = f.contentWindow;
        const response = Response.prototype.clone.call(new W.Response('x'));
        const request = Request.prototype.clone.call(new W.Request('/x'));
        return [Object.getPrototypeOf(response) === W.Response.prototype, Object.getPrototypeOf(request) === W.Request.prototype];
      })()
    JS
    expect(got).to eq([true, true])
  end

  # …but what refuses the method is the calling realm's: Web IDL makes its exception, and the promise its refusal rejects,
  # in the current realm — the success promise the frame's (Chrome and Firefox).
  it 'refuses another realm’s used body in the calling realm' do
    session = simulated_session(app)
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const f = document.body.appendChild(document.createElement('iframe'));
        const W = f.contentWindow;
        const used = new W.Response('x');
        used.body.getReader();
        let cloneError;
        try { Response.prototype.clone.call(used); } catch (e) { cloneError = e; }
        const rejected = Response.prototype.text.call(used);
        rejected.catch(() => {});
        const read = Response.prototype.text.call(new W.Response('y'));
        return [cloneError instanceof TypeError, rejected instanceof Promise, read instanceof W.Promise];
      })()
    JS
    expect(got).to eq([true, true, true])
  end
end
