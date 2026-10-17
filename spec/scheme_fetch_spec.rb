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
end
