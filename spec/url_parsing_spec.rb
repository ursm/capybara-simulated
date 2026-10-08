# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# URL parsing at scale. The spec-conformance side of `new URL()` lives in the WPT
# gate (`spec/wpt_gate`, url/); what this file guards is the COST of a parse, which
# no conformance test can see.
RSpec.describe 'URL parsing' do
  let(:app) {
    Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, ['<html><body>hi</body></html>']] }
    }.to_app
  }

  before { Capybara.app = app }

  # A `data:` URL is an opaque path, and a bundler that inlines a WASM binary makes
  # it MEGABYTES long (Emscripten's `tesseract-core.wasm.js` ships a 4.6 MB one).
  # Our fetch path parses every URL at least twice — to resolve the request, and to
  # strip the response URL's fragment — so a parser that walks such a path one code
  # point at a time turned ONE `fetch` into six seconds.
  #
  # Measured, 1 MB payload: 6-16 ms parsed in bulk vs 618-635 ms walked per code
  # point. An absolute bound can't separate those on a loaded CI worker, so the parse is
  # measured against a CALIBRATION batch of short parses on the same machine, in the
  # same script: the ratio is 0.5-1.7 when it's linear-with-a-small-constant and
  # 4.6-6.2 when it isn't. The big parse allocates a million-element array, so it is
  # sampled several times and the MINIMUM taken — one major GC landing in a single
  # sample is the only way this measurement goes wrong.
  it 'parses a megabyte-long data: URL against the cost of a short one' do
    session = simulated_session(app)
    session.visit '/'
    out = session.evaluate_script(<<~JS)
      // Every character class the opaque path treats differently: the plain run the
      // parser may take in bulk, the space it looks ahead from, and the `%` escape,
      // `?` and `#` that end it.
      const tail  = ' plain%20text?q=1#frag';
      const big   = 'data:text/plain,' + 'A'.repeat(1024 * 1024) + tail;
      const small = 'data:text/plain,' + 'A'.repeat(64) + tail;

      for (let i = 0; i < 200; i++) new URL(small);   // let the parse tier up first
      const c0 = Date.now();
      for (let i = 0; i < 2000; i++) new URL(small);
      const calMs = Date.now() - c0;

      let u = null, bigMs = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        u = new URL(big);
        bigMs = Math.min(bigMs, Date.now() - t0);
      }

      JSON.stringify({
        ratio:    bigMs / Math.max(calMs, 1),
        protocol: u.protocol,
        tail:     u.pathname.slice(-13),
        search:   u.search,
        hash:     u.hash
      });
    JS
    r = JSON.parse(out)
    # Chrome 151 splits it the same way: the opaque path keeps the literal space and
    # the `%20` untouched, and the query / fragment still terminate it.
    expect(r['protocol']).to eq('data:')
    expect(r['tail']).to eq(' plain%20text')
    expect(r['search']).to eq('?q=1')
    expect(r['hash']).to eq('#frag')
    expect(r['ratio']).to be < 3
  end
end

# URLSearchParams decodes with the driver's own UTF-8 decoder — a page that replaces or deletes `TextDecoder` broke
# every query with a percent-escape — and its surfaces say what Chrome says.
RSpec.describe 'URLSearchParams' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8">']] })
    s.visit('/')
    s
  }

  it 'decodes its pairs whatever a page does to TextDecoder' do
    got = session.evaluate_script(<<~JS)
      (() => {
        window.TextDecoder = class { decode() { return 'PWNED'; } };
        const replaced = new URLSearchParams('a=%C3%A9').get('a');
        delete window.TextDecoder;
        return [replaced, new URL('http://a.test/?b=%C3%A9').searchParams.get('b')];
      })()
    JS
    expect(got).to eq(%w[é é])
  end

  it "throws Chrome's errors: an invalid base, a forEach with nothing, an @@iterator that is no function" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.message; } };
        return [error(() => new URL('/x', 'nope')), error(() => new URLSearchParams().forEach()),
                error(() => new URLSearchParams({[Symbol.iterator]: 1}))];
      })()
    JS
    expect(got).to eq([
      "Failed to construct 'URL': Invalid base URL",
      "Failed to execute 'forEach' on 'URLSearchParams': 1 argument required, but only 0 present.",
      "Failed to construct 'URLSearchParams': The object must have a callable @@iterator property."
    ])
  end
end
