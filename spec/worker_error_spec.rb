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

  # One its Worker's `error` did not cancel is reported again at the global the Worker is in — an ErrorEvent of the
  # same message and place, its `error` null — and a canceled one is not (HTML "runtime script errors"; Chrome fires the
  # page's `onerror` after the Worker's).
  it "reports a worker's uncanceled exception again at the page" do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const log = [];
      window.onerror = (message, filename, lineno, colno, error) => {
        log.push(['page', message, filename.replace(location.origin, ''), lineno, error].join(' | '));
        return true;
      };
      new Worker('/boom.js').onerror = (e) => log.push('worker ' + e.message);
      new Worker('/boom.js').onerror = (e) => { e.preventDefault(); log.push('canceled ' + e.message); };
      setTimeout(() => done(log), 500);
    JS
    expect(got.sort).to eq(['canceled Error: boom', 'page | Error: boom | /boom.js | 2 | ', 'worker Error: boom'])
  end

  # A module worker (`{type: 'module'}`) runs its script as a module graph: a static import fetched and linked before it
  # runs, an `import()` fetched when called — in a classic worker too — and a graph that cannot be fetched or parsed a
  # plain `error` at its Worker, no exception reported up.
  it 'runs a module worker as a module graph, its imports and import() fetched' do
    app = lambda do |env|
      body = {
        '/'          => '<!doctype html><meta charset=utf-8>',
        '/net.js'    => "postMessage('net');",
        '/static.js' => "import './net.js';",
        '/dyn.js'    => "import('./net.js');",
        '/bad.js'    => "import './missing.js';"
      }[env['PATH_INFO']]
      next [404, {'content-type' => 'text/plain'}, ['nope']] unless body

      [200, {'content-type' => env['PATH_INFO'] == '/' ? 'text/html' : 'text/javascript'}, [body]]
    end
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [];
      window.onerror = (m) => { log.push('page ' + m); return true; };
      for (const [u, type] of [['/static.js', 'module'], ['/dyn.js', 'module'], ['/dyn.js', 'classic'], ['/bad.js', 'module']]) {
        const w = new Worker(u, {type});
        w.onmessage = (e) => log.push(`${u} ${type} ${e.data}`);
        w.onerror = (e) => log.push(`${u} ${type} ${e.constructor.name}`);
      }
      setTimeout(() => done(log), 500);
    JS
    expect(got.sort).to eq(['/bad.js module Event', '/dyn.js classic net', '/dyn.js module net', '/static.js module net'])
  end

  # A module's URL is its response's — a redirect's end — which its own imports resolve against and `import.meta.url`
  # reports; a data: module imports a data: one; and a blob: module's relative import has no base to resolve against, so
  # its graph fails.
  it "resolves a module's imports against its response URL, a blob: module's relative one against none" do
    app = lambda do |env|
      js = ->(body) { [200, {'content-type' => 'text/javascript'}, [body]] }
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8>']]
      when '/r/go.js' then [302, {'location' => '/sub/real.js'}, []]
      when '/sub/real.js' then js.call("import './dep.js'; postMessage(new URL(import.meta.url).pathname);")
      when '/sub/dep.js' then js.call("postMessage('dep');")
      when '/root.js' then js.call("import '/r/go.js';")
      else [404, {'content-type' => 'text/plain'}, ['nope']]
      end
    end
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], log = [];
      const blob = URL.createObjectURL(new Blob(["import './sub/dep.js';"], {type: 'text/javascript'}));
      const data = 'data:text/javascript,' + encodeURIComponent("import 'data:text/javascript,postMessage(1)';");
      for (const [name, u] of [['redirect', '/root.js'], ['data', data], ['blob', blob]]) {
        const w = new Worker(u, {type: 'module'});
        w.onmessage = (e) => log.push(`${name} ${e.data}`);
        w.onerror = (e) => log.push(`${name} ${e.constructor.name}`);
      }
      setTimeout(() => done(log), 500);
    JS
    expect(got.sort).to eq(['blob Event', 'data 1', 'redirect /sub/real.js', 'redirect dep'])
  end
end
