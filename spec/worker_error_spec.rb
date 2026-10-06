require 'capybara/simulated'
require_relative 'support/session_teardown'

# A worker's failures, as HTML fires them at its Worker: a script that could not be fetched, a simple `error` event; an
# exception its script or a listener threw, "report an exception" in the worker — an ErrorEvent of its message and place
# at the worker's global first and, unless a listener there canceled it, one at a dedicated worker's Worker (a shared
# worker's goes to no SharedWorker) — and the worker runs on.
RSpec.describe 'Worker errors' do
  let(:app) {
    lambda do |env|
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x']]
      when '/boom.js' then [200, {'content-type' => 'text/javascript'}, ["self.onmessage = (e) => { if (e.data === 'boom') throw new Error('inhandler'); postMessage('echo ' + e.data); };\nthrow new Error('boom');"]]
      when '/shared.js' then [200, {'content-type' => 'text/javascript'}, ["throw new Error('sharedboom');"]]
      when '/handled.js' then [200, {'content-type' => 'text/javascript'}, ["self.onerror = () => true;\nthrow new Error('quiet');"]]
      else [404, {'content-type' => 'text/plain'}, ['nope']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'fires them as HTML says' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const log = [];
      for (const u of ['/missing.js', '/boom.js', '/handled.js']) {
        const w = new Worker(u);
        w.onerror = (e) => log.push([u, e.constructor.name, e.message, (e.filename || '').replace(location.origin, ''), e.lineno].join(' | '));
        w.onmessage = (e) => log.push(e.data);
        if (u === '/boom.js') setTimeout(() => { w.postMessage('boom'); w.postMessage('hi'); }, 50);
      }
      new SharedWorker('/shared.js').onerror = (e) => log.push('shared ' + e.constructor.name);
      setTimeout(() => done(log), 500);
    JS
    expect(got.sort).to eq([
      '/boom.js | ErrorEvent | Error: boom | /boom.js | 2',
      '/boom.js | ErrorEvent | Error: inhandler | /boom.js | 1',
      '/missing.js | Event |  |  | ',
      'echo hi'
    ])
  end
end
