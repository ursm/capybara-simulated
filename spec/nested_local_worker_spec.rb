# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A worker may make a worker of a blob: or a data: URL as a page may (HTML "Worker constructor": any WorkerGlobalScope
# makes dedicated workers) — a blob: one of the parent's origin, a data: one of an opaque origin — and what fails of it
# is fired at the Worker object in the parent: a script that could not be fetched (a revoked blob) a simple `error`
# event, an exception its script threw an ErrorEvent; the parent runs on. Chrome 156 and Firefox 159 alike (measured
# 2026-11-02).
RSpec.describe 'a nested blob: / data: worker' do
  include PollUntil

  let(:app) {
    parent = <<~JS
      function run(label, url) {
        return new Promise((res) => {
          const w = new Worker(url);
          w.onmessage = (e) => { res(`${label}: ${e.data}`); };
          w.onerror = (e) => { e.preventDefault(); res(`${label}: ${e.constructor.name} ${e.message || ''}`.trim()); };
        });
      }
      (async () => {
        const out = [];
        const blob = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        out.push(await run('blob', blob('postMessage(`hi ${self.location.protocol} ${self.origin === location.origin}`)')));
        out.push(await run('data', 'data:text/javascript,postMessage(`hi ${self.origin}`)'));
        const revoked = blob('postMessage(1)');
        URL.revokeObjectURL(revoked);
        out.push(await run('revoked', revoked));
        out.push(await run('throw', blob('throw new Error("boom")')));
        out.push(await run('data-throw', 'data:text/javascript,throw new Error("dboom")'));
        out.push('next');
        postMessage(out);
      })();
    JS
    lambda {|env|
      case env['PATH_INFO']
      when '/parent.js' then [200, {'content-type' => 'text/javascript'}, [parent]]
      else [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>page']]
      end
    }
  }

  it 'runs, and fires its failures at its Worker in the parent' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      window.got = null;
      new Worker('/parent.js').onmessage = (e) => { window.got = e.data; };
    JS
    expect(poll_until { session.evaluate_script('window.got') }).to eq(
      [
        'blob: hi blob: true',
        'data: hi null',
        'revoked: Event',
        'throw: ErrorEvent Error: boom',
        'data-throw: ErrorEvent Error: dboom',
        'next'
      ]
    )
  end
end
