# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# Fetch `Response` value-type semantics: a disturbed/locked stream body is rejected at
# construction, `Response.json` throws on a non-encodable value, and a network-fetched
# response's headers are immutable.
RSpec.describe 'Fetch Response semantics' do
  let(:app) {
    Rack::Builder.new {
      run lambda {|env|
        case Rack::Request.new(env).path_info
        when '/'     then [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']]
        when '/data' then [200, {'content-type' => 'application/json'}, ['{"ok":true}']]
        else              [404, {'content-type' => 'text/plain'}, ['nope']]
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
    sleep 0.1
    r = JSON.parse(session.evaluate_script('globalThis.__r'))
    expect(r['builtMutable']).to eq('no-throw')
    expect(r['builtHas']).to eq('v')
    expect(r['fetchedThrew']).to eq('TypeError')
    expect(r['fetchedHas']).to be_nil
  end
end
