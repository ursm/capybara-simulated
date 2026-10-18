# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# XMLHttpRequest, its upload and their event target, generated from their IDL: the progress handlers on
# XMLHttpRequestEventTarget, no constructor of its own, a body converted as its union says, no implementation on the
# prototype, a send aborted or opened again stale, and a response decoded natively whatever a page does to
# TextDecoder. The figures are headless Chrome's — but for a raw SharedArrayBuffer body, which Web IDL's union
# conversion stringifies (its ArrayBuffer step takes only a buffer IsSharedArrayBuffer is false of) where Chrome and
# Firefox throw.
RSpec.describe 'XMLHttpRequest bindings' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/latin1'
        [200, {'content-type' => 'text/plain;charset=windows-1252'}, ["\x80 caf\xE9".b]]
      elsif env['REQUEST_METHOD'] == 'POST'
        [200, {'content-type' => 'text/plain'}, [env['rack.input'].read]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']]
      end
    end
  }
  let(:session) {
    s = simulated_session(app)
    s.visit('/')
    s
  }

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.name + ': ' + e.message; } };
        const sab = new WebAssembly.Memory({shared: true, initial: 1, maximum: 1}).buffer;
        const opened = () => { const x = new XMLHttpRequest(); x.open('POST', '/x'); return x; };
        return [
          !!Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'onload'),
          !!Object.getOwnPropertyDescriptor(XMLHttpRequestEventTarget.prototype, 'onload'),
          !!Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'onreadystatechange'),
          error(() => opened().send(sab)),
          error(() => opened().send(new Uint8Array(sab))),
          error(() => new XMLHttpRequestEventTarget()),
          Object.prototype.toString.call(new XMLHttpRequest().upload),
          Object.getOwnPropertyNames(XMLHttpRequest.prototype).filter((k) => k.startsWith('_')).length
        ];
      })()
    JS
    expect(got).to eq([
      false, true, true,
      'none',
      "TypeError: Failed to execute 'send' on 'XMLHttpRequest': The provided ArrayBufferView value must not be shared.",
      "TypeError: Failed to construct 'XMLHttpRequestEventTarget': Illegal constructor",
      '[object XMLHttpRequestUpload]',
      0
    ])
  end

  it 'decodes a response natively, whatever a page does to TextDecoder' do
    session.execute_script(<<~JS)
      window.TextDecoder = function () { throw new Error('page'); };
      const x = new XMLHttpRequest();
      x.open('GET', '/latin1');
      x.onload = () => { window.got = x.responseText; };
      x.send();
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to eq('€ café')
  end

  it 'answers only the send of its latest open()' do
    session.execute_script(<<~JS)
      const x = new XMLHttpRequest(), events = [];
      x.onreadystatechange = () => events.push('rsc' + x.readyState);
      x.onload = () => { events.push('load:' + x.responseText); window.got = events; };
      x.open('POST', '/echo');
      x.send('first');
      x.abort();
      x.open('POST', '/echo');
      x.send('second');
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got.join(" ")')).to eq('rsc1 rsc4 rsc1 rsc2 rsc3 rsc4 load:second')
  end

  # Chrome's sequences (measured over a local echo server) — but for S3, where Chrome lets one stale `progress` through
  # after the open() inside the rsc3 handler, where XHR's open() "terminates this's fetch controller": nothing of the
  # first send fires after it. A load / error handler's open() leaves its loadend, which the end-of-body and
  # request-error steps fire straight after it.
  it "answers a send whose handler opens it again only with the new send's events" do
    session.execute_script(<<~JS)
      window.got = {};
      const runCase = (name, url, method, hook) => {
        const x = new XMLHttpRequest(), events = [];
        x.onreadystatechange = () => { events.push('rsc' + x.readyState); hook(x, 'rsc' + x.readyState); };
        for (const t of ['loadstart', 'progress', 'abort', 'error']) x.addEventListener(t, () => { events.push(t); hook(x, t); });
        x.onload = () => { events.push('load:' + x.responseText); hook(x, 'load'); };
        x.onloadend = () => events.push('loadend');
        x.open(method, url);
        x.send(method === 'POST' ? 'first' : null);
        setTimeout(() => { window.got[name] = events.join(' '); }, 500);
      };
      const reopen = (event, send) => {
        let once = true;
        return (x, ev) => {
          if (ev !== event || !once) return;
          once = false;
          if (event === 'loadstart') x.abort();
          x.open('POST', '/echo');
          if (send) x.send('second');
        };
      };
      runCase('s7', '/echo', 'POST', reopen('loadstart', true));
      runCase('s3', '/echo', 'POST', reopen('rsc3', true));
      runCase('s6', '/echo', 'POST', reopen('load', true));
      runCase('s8', 'data:bad', 'POST', reopen('error', false));
      runCase('s9', URL.createObjectURL(new Blob(['bb'])), 'GET', reopen('load', false));
    JS
    poll_until { session.evaluate_script('window.got.s9') }
    expect(session.evaluate_script('window.got')).to eq(
      's7' => 'rsc1 loadstart rsc4 abort loadend rsc1 loadstart rsc2 rsc3 progress rsc4 load:second loadend',
      's3' => 'rsc1 loadstart rsc2 rsc3 rsc1 loadstart rsc2 rsc3 progress rsc4 load:second loadend',
      's6' => 'rsc1 loadstart rsc2 rsc3 progress rsc4 load:first rsc1 loadstart loadend rsc2 rsc3 progress rsc4 load:second loadend',
      's8' => 'rsc1 loadstart rsc4 error rsc1 loadend',
      's9' => 'rsc1 loadstart rsc2 rsc3 progress rsc4 load:bb rsc1 loadend'
    )
  end

  it "reports the bytes a response's body carried as its progress, not its decoded characters" do
    session.execute_script(<<~JS)
      window.got = {};
      const load = (name, blob, responseType, async = true) => {
        const x = new XMLHttpRequest();
        x.open('GET', URL.createObjectURL(blob), async);
        if (responseType) x.responseType = responseType;
        x.onload = (e) => { window.got[name] = [e.loaded, e.total, e.lengthComputable]; };
        x.send();
      };
      load('text', new Blob(['hé€']));
      load('arraybuffer', new Blob([new Uint8Array([0xC3, 0xA9])]), 'arraybuffer');
      load('sync', new Blob(['sé']), '', false);
    JS
    poll_until { session.evaluate_script('Object.keys(window.got).length === 3') }
    expect(session.evaluate_script('window.got')).to eq(
      'text' => [6, 6, true], 'arraybuffer' => [2, 2, true], 'sync' => [3, 3, true]
    )
  end

  # …its total the length the response's Content-Length gives — Fetch "extract a length", the engine's (headers.rs
  # `extract_length`): its values all the same, of ASCII digits — and 0, not computable, where it gives none: `5, 6` had
  # been read as 5 (`parseInt` of its first digits); and each of its fields is read without the HTTP whitespace around
  # it, as an HTTP stack reads one (Chrome and Firefox: `" 5 "` is `5`).
  it "totals its progress by what the response's Content-Length extracts to" do
    lengths = {'/same' => '5, 5', '/differ' => '5, 6', '/junk' => '5x', '/spaced' => ' 5 '}
    s = simulated_session(lambda {|env|
      next [200, {'content-type' => 'text/plain', 'content-length' => lengths[env['PATH_INFO']]}, ['hello']] if lengths.key?(env['PATH_INFO'])
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = {};
      for (const path of #{lengths.keys.to_json}) {
        const x = new XMLHttpRequest();
        x.open('GET', path);
        x.onprogress = (e) => { got[path] = [e.total, e.lengthComputable, x.getResponseHeader('content-length')]; };
        x.send();
      }
    JS
    got = poll_until { v = s.evaluate_script('window.got'); v.size == lengths.size ? v : nil }
    expect(got).to eq(
      '/same' => [5, true, '5, 5'], '/differ' => [0, false, '5, 6'], '/junk' => [0, false, '5x'], '/spaced' => [5, true, '5']
    )
  end

  # The final MIME type is the one the Content-Type gives (Fetch's "extract a MIME type"), and an XML document is
  # parsed only for an XML MIME type (MIME Sniffing: a `+xml` subtype, text/xml, application/xml) — not any `*/xml`.
  it 'parses responseXML for an XML MIME type alone' do
    session.execute_script(<<~JS)
      window.got = {};
      for (const type of ['application/xml', 'image/svg+xml', 'image/xml', 'text/plain']) {
        const x = new XMLHttpRequest();
        x.open('GET', URL.createObjectURL(new Blob(['<r/>'], {type})));
        x.onload = () => { window.got[type] = x.responseXML ? x.responseXML.documentElement.localName : null; };
        x.send();
      }
    JS
    poll_until { session.evaluate_script('Object.keys(window.got).length === 4') }
    expect(session.evaluate_script('window.got')).to eq(
      'application/xml' => 'r', 'image/svg+xml' => 'r', 'image/xml' => nil, 'text/plain' => nil
    )
  end

  # A charset that names no encoding is none at all (XHR "get a final encoding": "get an encoding" of the label, a
  # failure null), so an XML response's own declaration decides how its text decodes — a quoted empty one and a bogus one
  # alike (Chrome: `é` from a windows-1252 declaration under both).
  it 'decodes an XML response by its declaration where the charset names no encoding' do
    session.execute_script(<<~JS)
      window.got = {};
      const bytes = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><a>'), 0xE9, ...new TextEncoder().encode('</a>')]);
      for (const type of ['text/xml;charset=""', 'application/xml;charset=bogus']) {
        const x = new XMLHttpRequest();
        x.open('GET', URL.createObjectURL(new Blob([bytes], {type})));
        x.onload = () => { window.got[type] = escape(x.responseText.slice(x.responseText.indexOf('<a>'))); };
        x.send();
      }
    JS
    poll_until { session.evaluate_script('Object.keys(window.got).length === 2') }
    expect(session.evaluate_script('window.got')).to eq('text/xml;charset=""' => '%3Ca%3E%E9%3C/a%3E', 'application/xml;charset=bogus' => '%3Ca%3E%E9%3C/a%3E')
  end
end
