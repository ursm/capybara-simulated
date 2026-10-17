# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# Fetch's scheme fetch of a `blob:` URL is one set of rules, the engine's (fetch_rules.rs `blob_response`), which fetch()
# and XHR share — a GET alone, a single byte range a 206 of that slice with its Content-Range, the blob's type the
# Content-Type where it parses as a MIME type — and a `blob:` classic script's response is decoded as a fetched one's
# is, by its Content-Type's charset (it was decoded as UTF-8 whatever its type said), a parser-inserted one too.
RSpec.describe 'scheme fetch' do
  let(:page) { '<!DOCTYPE html><meta charset="utf-8"><body>' }
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s
  }

  it 'answers a byte range of a blob URL, alike through fetch() and XHR' do
    session.execute_script(<<~JS)
      const url = URL.createObjectURL(new Blob(['abcdef'], { type: 'text/plain' }));
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.setRequestHeader('Range', 'bytes=1-3');
      xhr.send();
      window.viaXhr = [xhr.status, xhr.responseText, xhr.getResponseHeader('content-range')];
      fetch(url, { headers: { Range: 'bytes=1-3' } })
        .then((r) => r.text().then((t) => [r.status, t, r.headers.get('content-range'), r.headers.get('content-type')]))
        .then((got) => fetch(url, { method: 'POST' }).then(() => got.concat('posted'), () => got.concat('refused')))
        .then((got) => { window.viaFetch = got; });
    JS
    expect(poll_until { session.evaluate_script('window.viaFetch') }).to eq([206, 'bcd', 'bytes 1-3/6', 'text/plain', 'refused'])
    expect(session.evaluate_script('window.viaXhr')).to eq([206, 'bcd', 'bytes 1-3/6'])
  end

  it 'decodes a blob URL script by its type\'s charset, inserted by a script or by the parser' do
    session.execute_script(<<~JS)
      const latin1 = (name) => URL.createObjectURL(new Blob([new Uint8Array([...('window.' + name + " = '").split('').map((c) => c.charCodeAt(0)), 0xe9, 0x27])],
        { type: 'text/javascript;charset=windows-1252' }));
      const script = document.createElement('script');
      script.src = latin1('inserted');
      document.body.appendChild(script);
      document.write('<script src="' + latin1('parsed') + '"><\\/script>');
    JS
    expect(poll_until { session.evaluate_script('window.inserted') }).to eq('é')
    expect(poll_until { session.evaluate_script('window.parsed') }).to eq('é')
  end

  # An empty `data:` or `blob:` script is a loaded one (its `load` fires, Chrome and Firefox), the parser's too — not an
  # inline script waiting for its text — and the src names its scheme as the URL parser reads it: whitespace around it
  # stripped, the scheme ASCII-case-insensitive.
  it 'loads an empty data: or blob: script, and reads its scheme off the parsed src' do
    session.execute_script(<<~JS)
      window.events = [];
      const empty = URL.createObjectURL(new Blob([], { type: 'text/javascript' }));
      const ran = URL.createObjectURL(new Blob(['window.events.push("ran")'], { type: 'text/javascript' }));
      const tag = (name, src) => '<script src="' + src + '" onload="events.push(\\'' + name + ' load\\')" onerror="events.push(\\'' + name + ' error\\')"><\\/script>';
      document.write(tag('blob', empty) + tag('data', 'data:text/javascript,') + tag('spaced', ' ' + ran.toUpperCase().slice(0, 4) + ran.slice(4) + ' '));
    JS
    expect(poll_until { v = session.evaluate_script('window.events'); v.length >= 4 ? v : nil }).to eq(['blob load', 'data load', 'ran', 'spaced load'])
  end

  # A parser-run script's `load` or `error` fires as the parser runs it (HTML "execute the script element"), before the
  # parser goes on to what follows it — an empty one's and a failed one's too (Chrome, Firefox) — and the microtasks its
  # handlers queued run before that too (Chrome).
  it 'fires a parser-run script\'s load or error before the parser goes on' do
    session.execute_script(<<~JS)
      window.order = [];
      const step = (name) => '<script>order.push("' + name + '")<\\/script>';
      const tag = (name, src) => '<script src="' + src + '" onload="order.push(\\'' + name + ' load\\')" onerror="order.push(\\'' + name + ' error\\')"><\\/script>';
      document.write(tag('empty', 'data:text/javascript,') + step('after empty') + tag('bad', 'data:text/javascript;base64,%%%') + step('after bad'));
      const queued = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
      document.write('<script src="' + queued + '" onload="Promise.resolve().then(() => order.push(\\'micro\\'))"><\\/script>' + step('after micro'));
    JS
    expect(poll_until { v = session.evaluate_script('window.order'); v.length >= 6 ? v : nil })
      .to eq(['empty load', 'after empty', 'bad error', 'after bad', 'micro', 'after micro'])
  end
end
