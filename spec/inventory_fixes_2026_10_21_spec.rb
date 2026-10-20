# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Three departures the 2026-10-21 survey found, each checked against its spec before the fix:
# - Fetch's main fetch applies a request's integrity metadata to EVERY response, whatever scheme answered it: a `data:`
#   or `blob:` body that matches none of it is a network error (it resolved).
# - HTML's play() rejects with a NotSupportedError for an element whose error is MEDIA_ERR_SRC_NOT_SUPPORTED (it
#   resolved).
# - Typing into an editing host fires each character's events alone: no `input` of the whole value after them, which
#   no browser fires.
RSpec.describe 'Fixes from the 2026-10-21 survey' do
  let(:session) {
    simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset=utf-8><body><div id=ce contenteditable></div>
        <script>
          window.log = [];
          for (const t of ['beforeinput', 'input']) document.getElementById('ce').addEventListener(t, (e) => log.push(t + ':' + e.data));
        </script>
      HTML
    })
  }

  before { session.visit '/' }

  it "checks a data: or blob: response's body against the request's integrity" do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      (async () => {
        const r = [];
        const good = 'sha256-LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE=';
        for (const url of ['data:,x', URL.createObjectURL(new Blob(['x']))]) {
          for (const integrity of ['sha256-bogus', good]) {
            try { await fetch(url, {integrity}); r.push('resolved'); } catch (e) { r.push(e.name); }
          }
        }
        return r;
      })().then(done);
    JS
    expect(got).to eq(%w[TypeError resolved TypeError resolved])
  end

  it 'rejects play() for a media element whose source is not supported' do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const v = document.createElement('video');
      v.onerror = () => v.play().then(() => done('resolved'), (e) => done(e.name + ' ' + v.error.code));
      v.src = 'data:text/plain,nope';
    JS
    expect(got).to eq('NotSupportedError 4')
  end

  it "fires each typed character's input into an editing host, and no other" do
    session.find('#ce').set('ab')
    expect(session.evaluate_script('log')).to eq(%w[beforeinput:a input:a beforeinput:b input:b])
  end
end
