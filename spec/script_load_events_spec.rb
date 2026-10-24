require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "execute the script element": a script from an external file fires `load` once it has run, whatever it threw —
# the throw reported (`window.onerror`) — and `error` only where it could not be fetched; a module's `src` resolves
# against its document's base URL. Chrome 155 on this page: `onerror TypeError | classic load | module load true |
# onerror RangeError | mthrow load | missing error`. A module that does not parse — the script's, or one it imports — is
# no failed fetch: Chrome reports its SyntaxError and fires `load`; one importing a module that cannot be fetched fires
# `error`, as does one served as no JavaScript MIME type (`text/plain`), which never runs. A module's throw is reported
# before its `load`, as a classic one's is — and a module's SyntaxError, the script's or one it imports, alike.
RSpec.describe 'script load events' do
  let(:page) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><base href="/sub/"><script>
        window.log = [];
        onerror = (m, f, l, c, e) => { log.push('onerror ' + (e && e.constructor.name)); };
      </script>
      <script src="/throw.js" onload="log.push('classic load')" onerror="log.push('classic error')"></script>
      <script type="module" src="m.js" onload="log.push('module load ' + window.subran)" onerror="log.push('module error')"></script>
      <script type="module" src="/mthrow.js" onload="log.push('mthrow load')" onerror="log.push('mthrow error')"></script>
      <script type="module" src="/missing.js" onload="log.push('missing load')" onerror="log.push('missing error')"></script>
      <script type="module" src="/syntax.js" onload="log.push('syntax load')" onerror="log.push('syntax error')"></script>
      <script type="module" src="/depsyntax.js" onload="log.push('depsyntax load')" onerror="log.push('depsyntax error')"></script>
      <script type="module" src="/depmissing.js" onload="log.push('depmissing load')" onerror="log.push('depmissing error')"></script>
      <script type="module" src="/plain.txt" onload="log.push('plain load ' + !!window.plainran)" onerror="log.push('plain error ' + !!window.plainran)"></script>
    HTML
  }

  it 'fires load for a script that ran, whatever it threw, and error for one that could not be fetched' do
    html = page
    s = simulated_session(->(env) {
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, [html]]
      when '/throw.js' then [200, {'content-type' => 'text/javascript'}, ['throw new TypeError("boom")']]
      when '/sub/m.js' then [200, {'content-type' => 'text/javascript'}, ['window.subran = true']]
      when '/mthrow.js' then [200, {'content-type' => 'text/javascript'}, ['throw new RangeError("mboom")']]
      when '/syntax.js' then [200, {'content-type' => 'text/javascript'}, ['export {;']]
      when '/depsyntax.js' then [200, {'content-type' => 'text/javascript'}, ['import "/syntax.js";']]
      when '/depmissing.js' then [200, {'content-type' => 'text/javascript'}, ['import "/missing.js";']]
      when '/plain.txt' then [200, {'content-type' => 'text/plain'}, ['window.plainran = true']]
      else [404, {'content-type' => 'text/javascript'}, ['']]
      end
    })
    s.visit '/'
    expect(s.evaluate_async_script('setTimeout(() => arguments[0](log), 10)')).to eq(
      [
        'onerror TypeError',
        'classic load',
        'module load true',
        'onerror RangeError',
        'mthrow load',
        'missing error',
        'onerror SyntaxError',
        'syntax load',
        'onerror SyntaxError',
        'depsyntax load',
        'depmissing error',
        'plain error false'
      ]
    )
  end

  # A page that loads one URL twice runs it twice (each `<script>` element is a script of its own), each firing `load`.
  it 'runs a script loaded twice by one page twice' do
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/javascript'}, ['window.runs = (window.runs || 0) + 1']] if env['PATH_INFO'] == '/twice.js'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><script>window.loads = 0;</script>
        <script src="/twice.js" onload="loads++"></script><script src="/twice.js" onload="loads++"></script>
      HTML
    })
    s.visit '/'
    expect(s.evaluate_async_script('setTimeout(() => arguments[0]([runs, loads]), 10)')).to eq([2, 2])
  end

  # A script another script inserted runs from a task of its own, its JS stack empty: "clean up after running script"
  # runs the microtasks it queued before its `load` — `document.currentScript` still it — as a parser-run one's.
  it 'runs an inserted external script’s microtasks before its load' do
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/javascript'}, ['Promise.resolve().then(() => log.push("micro " + (document.currentScript && document.currentScript.id)))']] if env['PATH_INFO'] == '/m.js'
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      window.log = [];
      const el = Object.assign(document.createElement('script'), { id: 'ins', src: '/m.js' });
      el.onload = () => log.push('load');
      document.head.appendChild(el);
    JS
    expect(s.evaluate_async_script('setTimeout(() => arguments[0](log), 10)')).to eq(['micro ins', 'load'])
  end

  # A script from an external file — as it was prepared, its `src` removed before its task runs it or not — runs with
  # its document's ignore-destructive-writes counter raised, its microtasks' `document.write` included, which then
  # writes nothing; a script a `document.write` parses runs inside the one that wrote it, its microtask checkpoint
  # left to that one. Chrome: `intact`, `w ran | w micro | load`, `B | A after | A micro`.
  it 'ignores an external script’s destructive writes, and checkpoints only the outermost script' do
    s = simulated_session(->(env) {
      case env['PATH_INFO']
      when '/d.js' then [200, {'content-type' => 'text/javascript'}, ['document.write("<p id=clobber>x</p>")']]
      when '/w.js' then [200, {'content-type' => 'text/javascript'}, ['log.push("w ran"); Promise.resolve().then(() => { log.push("w micro"); document.write("<p id=clobber>x</p>"); })']]
      when '/nested' then [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><script>window.log = [];</script><script>
        Promise.resolve().then(() => log.push('A micro'));
        document.write('<script>log.push("B")<\\/script>');
        log.push('A after');
        </script>
      HTML
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p id=intact>intact</p>']]
      end
    })
    s.visit '/'
    s.execute_script(<<~JS)
      window.log = [];
      const d = Object.assign(document.createElement('script'), { src: '/d.js' });
      document.head.appendChild(d);
      d.removeAttribute('src');
      const w = Object.assign(document.createElement('script'), { src: '/w.js' });
      w.onload = () => log.push('load');
      document.head.appendChild(w);
    JS
    expect(s.evaluate_async_script('setTimeout(() => arguments[0]([!!document.getElementById("intact"), log]), 20)')).to eq([true, ['w ran', 'w micro', 'load']])
    s.visit '/nested'
    nested = s.evaluate_script('log')
    expect(nested).to eq(['B', 'A after', 'A micro'])
  end
end
