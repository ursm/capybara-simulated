# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The module map (module_map.rs): a document's modules keyed by (URL, module type), the module type its import's `type`
# attribute names — never its URL — and a module script's graph fetched as it is prepared, each module's imports fetched
# as it comes in, in parallel, the script run once its last module is in. Every expectation is Chrome's and Firefox's
# (csim-bench mod8 probes, 2026-11-27).
RSpec.describe 'the module map' do
  MODULE_MAP_TYPES = {
    'js'   => 'text/javascript',
    'json' => 'application/json',
    'css'  => 'text/css',
    'txt'  => 'text/plain'
  }.freeze

  # A page whose script logs into `L` (shown in `#out` once its title is `done`), and the files it fetches: a fixed body
  # at each path of `files`, `?ct=` naming the response's type in place of its extension's, `/slow/<ms>/…` the same file
  # as late; `/redir?to=` a redirect; every request counted (`/counts`).
  let(:counts) { Hash.new(0) }

  def session_of(page, files = {})
    counts = self.counts
    simulated_session(lambda {|env|
      path, query = env['PATH_INFO'], Rack::Utils.parse_query(env['QUERY_STRING'])
      next [200, {'content-type' => 'application/json'}, [counts.to_json]] if path == '/counts'
      next [302, {'location' => query['to']}, []] if path == '/redir'

      counts[[path, env['QUERY_STRING']].reject(&:empty?).join('?')] += 1
      if (slow = path.match(%r{\A/slow/(\d+)(/.*)\z}))
        sleep(slow[1].to_i / 1000.0)
        path = slow[2]
      end
      next [200, {'content-type' => 'text/html'}, [<<~HTML]] if path == '/'
        <!DOCTYPE html><meta charset="utf-8"><title>x</title><pre id="out"></pre>
        <script>
          const L = window.L = [];
          onerror = (message, file, line, column, error) => L.push('error:' + (error && error.name));
          window.done = () => { document.getElementById('out').textContent = L.join(' '); document.title = 'done'; };
        </script>#{page}
      HTML
      next [404, {}, ['']] unless files.key?(path)

      headers = {'content-type' => query['ct'] || MODULE_MAP_TYPES.fetch(path.split('.').last, 'text/plain')}
      headers['cache-control'] = 'max-age=3600' if query.key?('fresh')
      [200, headers, [files[path]]]
    })
  end

  def log_of(page, files = {})
    session = session_of(page, files)
    session.visit '/'
    expect(session).to have_title('done', wait: 10)
    session.find('#out', visible: :all).text(:all)
  end

  describe 'a module type' do
    let(:files) {
      {
        '/d.json'  => '{"x": 1}',
        '/d.txt'   => '{"x": 2}',
        '/p.json'  => '{"__proto__": {"p": 1}, "a": [-0, {"__proto__": null}]}',
        '/bad.json' => '{"x": 1,}',
        '/s.css'   => 'p { color: rgb(1, 2, 3) }',
        '/t.txt'   => "hello\n",
        '/x.js'    => "L.push('x-ran'); export const x = 1;"
      }
    }

    it 'is the one its `type` attribute names, whatever the URL' do
      expect(log_of(<<~HTML, files)).to eq('json:1 txt-as-json:2 text:"hello\\n" css:CSSStyleSheet:1')
        <script type="module">
          import a from '/d.json' with { type: 'json' };
          import b from '/d.txt?ct=application/json' with { type: 'json' };
          import t from '/t.txt' with { type: 'text' };
          import s from '/s.css' with { type: 'css' };
          L.push('json:' + a.x, 'txt-as-json:' + b.x, 'text:' + JSON.stringify(t), 'css:' + s.constructor.name + ':' + s.cssRules.length);
          done();
        </script>
      HTML
    end

    it 'is JavaScript where no `type` names one, a JSON response then no module' do
      expect(log_of(<<~HTML, files.merge('/imp.js' => "import d from '/d.json'; L.push('ran2');"))).to eq('error1 error2')
        <script type="module" onerror="L.push('error1')">import d from '/d.json'; L.push('ran');</script>
        <script type="module" src="/imp.js" onload="L.push('load2')" onerror="L.push('error2')"></script>
        <script>setTimeout(done, 200)</script>
      HTML
    end

    it "fails its module script's graph with a TypeError where its `type` names none" do
      expect(log_of(<<~HTML, files)).to eq('error:TypeError error:TypeError')
        <script type="module">import x from '/x.js' with { type: 'bogus' }; L.push('ran');</script>
        <script type="module">import x from '/x.js' with { type: 'javascript-or-wasm' }; L.push('ran');</script>
        <script>setTimeout(done, 200)</script>
      HTML
    end

    it "makes a JSON module's value as JSON.parse makes it, and a parse error of JSON that is none" do
      expect(log_of(<<~HTML, files)).to eq('true true true true true error:SyntaxError')
        <script type="module">
          import p from '/p.json' with { type: 'json' };
          L.push(Object.getPrototypeOf(p) === Object.prototype, Object.hasOwn(p, '__proto__'), Object.is(p.a[0], -0),
                 Object.getPrototypeOf(p.a[1]) === Object.prototype, Object.hasOwn(p.a[1], '__proto__'));
        </script>
        <script type="module">import b from '/bad.json' with { type: 'json' }; L.push('ran');</script>
        <script>setTimeout(done, 200)</script>
      HTML
    end

    it 'keys the map by URL and module type: one URL fetched for each type it is imported as' do
      expect(log_of(<<~HTML, files)).to eq('json:2 js-failed n=2')
        <script type="module">
          import d from '/d.txt?ct=application/json&k' with { type: 'json' };
          L.push('json:' + d.x);
          import('/d.txt?ct=application/json&k').then(() => L.push('js-ran'), () => L.push('js-failed'))
            .then(() => fetch('/counts')).then((r) => r.json()).then((c) => { L.push('n=' + c['/d.txt?ct=application/json&k']); done(); });
        </script>
      HTML
    end
  end

  describe "a module script's graph" do
    let(:files) {
      {
        '/x.js'    => "L.push('x-ran'); export const x = 1;",
        '/y.js'    => "L.push('y-ran'); export const y = 2;",
        '/m.js'    => "import '/slow/300/x.js'; L.push('m-ran');",
        '/par.js'  => "import '/slow/200/x.js'; import '/slow/200/y.js'; L.push('par-ran');",
        '/sub/meta.js' => "export const u = import.meta.url; export { v } from './rel.js';",
        '/sub/rel.js'  => "export const v = 'sub';",
        '/rel.js'      => "export const v = 'top';"
      }
    }

    it 'is fetched before it runs, the event loop running on as its imports come in' do
      expect(log_of(<<~HTML, files)).to eq('t100 x-ran m-ran')
        <script>setTimeout(() => L.push('t100'), 100); setTimeout(done, 1000);</script>
        <script type="module" src="/m.js"></script>
      HTML
    end

    it "fetches a module's imports in parallel" do
      expect(log_of(<<~HTML, files)).to eq('t100 x-ran y-ran par-ran t300')
        <script>setTimeout(() => L.push('t300'), 300); setTimeout(() => L.push('t100'), 100); setTimeout(done, 1000);</script>
        <script type="module" src="/par.js"></script>
      HTML
    end

    it "lands an `async` inline module's graph as its imports come in, after a deferred one's" do
      expect(log_of(<<~HTML, files)).to eq('y-ran dcl x-ran async-ran load')
        <script>setTimeout(done, 1000); addEventListener('DOMContentLoaded', () => L.push('dcl')); addEventListener('load', () => L.push('load'));</script>
        <script type="module" async>import '/slow/300/x.js'; L.push('async-ran');</script>
        <script type="module" src="/slow/100/y.js"></script>
      HTML
    end

    it "fetches a module once however many graphs import it" do
      expect(log_of(<<~HTML, files)).to eq('x-ran a b n=1')
        <script type="module">import '/x.js?once'; L.push('a');</script>
        <script type="module">import '/x.js?once'; L.push('b');</script>
        <script type="module">import('/x.js?once').then(() => fetch('/counts')).then((r) => r.json()).then((c) => { L.push('n=' + c['/x.js?once']); done(); });</script>
      HTML
    end

    # HTML "fetch the descendants of and link": the first failure its loading meets decides — a fetch that failed while no
    # error to rethrow was set nulls the graph (`error` at the element), a parse error met first is rethrown at the window
    # (Firefox both; Chrome nulls a graph with any failed fetch).
    it 'fails as the first failure its loading meets' do
      graphs = files.merge('/a.js' => 'export const a = ;', '/e.js' => "import '/slow/300/a.js'; import '/missing.js';",
                           '/f.js' => "import '/a.js'; import '/slow/300/missing.js';")
      expect(log_of(<<~HTML, graphs)).to eq('e:error error:SyntaxError f:load')
        <script>setTimeout(done, 1000);</script>
        <script type="module" src="/e.js" onload="L.push('e:load')" onerror="L.push('e:error')"></script>
        <script type="module" src="/f.js" onload="L.push('f:load')" onerror="L.push('f:error')"></script>
      HTML
    end

    # A JSON module nested past what a literal compiles to is JSON.parse's value all the same (Chrome).
    it 'imports a JSON module however deeply it nests' do
      deep = files.merge('/deep.json' => ('[' * 20_000) + (']' * 20_000))
      expect(log_of(<<~HTML, deep)).to eq('deep:true')
        <script type="module">import d from '/deep.json' with { type: 'json' }; L.push('deep:' + Array.isArray(d[0][0])); done();</script>
      HTML
    end

    # …and a module a cache answers files its Resource Timing entry as one fetched does.
    it "files a Resource Timing entry for a module the cache answers" do
      session = session_of(<<~HTML, files)
        <script type="module" src="/x.js?fresh" onload="L.push(performance.getEntriesByType('resource').some((e) => e.name.endsWith('/x.js?fresh'))); done()"></script>
      HTML
      2.times do
        session.visit '/'
        expect(session).to have_title('done', wait: 10)
        expect(session.find('#out', visible: :all).text(:all)).to eq('x-ran true')
      end
    end

    it "takes a redirected module's base URL from its response, keying it by its request's" do
      expect(log_of(<<~HTML, files)).to eq('http://www.example.com/sub/meta.js sub n=2')
        <script type="module">
          import { u, v } from '/redir?to=/sub/meta.js';
          import '/sub/meta.js';
          L.push(u, v);
          setTimeout(() => fetch('/counts').then((r) => r.json()).then((c) => { L.push('n=' + c['/sub/meta.js']); done(); }), 100);
        </script>
      HTML
    end
  end

  # HTML "merge existing and new import maps": a map registered after a specifier resolved keeps that resolution, its
  # other rules merged (Chrome `a1 a1 b b`; Firefox registers no map once a module has loaded: `b!TypeError c!TypeError`
  # — the spec's merge is explicit, csim-bench mod8 `im_late`).
  describe 'an import map' do
    it 'changes no specifier already resolved' do
      files = {'/a1.js' => "export default 'a1';", '/a2.js' => "export default 'a2';", '/b.js' => "export default 'b';"}
      expect(log_of(<<~HTML, files)).to eq('a1 a1 b b')
        <script type="importmap">{"imports": {"a": "/a1.js"}}</script>
        <script type="module">
          import a from 'a';
          L.push(a);
          const map = document.createElement('script');
          map.type = 'importmap';
          map.textContent = JSON.stringify({ imports: { a: '/a2.js', b: '/b.js' }, scopes: { '/': { a: '/a2.js', c: '/b.js' } } });
          document.head.append(map);
          Promise.all(['a', 'b', 'c'].map((s) => import(s).catch((e) => ({ default: s + '!' + e.name }))))
            .then((ms) => { L.push(...ms.map((m) => m.default)); done(); });
        </script>
      HTML
    end
  end
end
