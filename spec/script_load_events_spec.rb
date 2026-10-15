require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "execute the script element": a script from an external file fires `load` once it has run, whatever it threw —
# the throw reported (`window.onerror`) — and `error` only where it could not be fetched; a module's `src` resolves
# against its document's base URL. Chrome 155 on this page: `onerror TypeError | classic load | module load true |
# onerror RangeError | mthrow load | missing error`. A module that does not parse — the script's, or one it imports — is
# no failed fetch: Chrome reports its SyntaxError and fires `load`; one importing a module that cannot be fetched fires
# `error`, as does one served as no JavaScript MIME type (`text/plain`), which never runs. (A module's throw and parse error are logged, not yet reported: the host evaluates the graph and the thrown
# value does not cross back — the `onerror` Chrome adds for each.)
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
      ['onerror TypeError', 'classic load', 'module load true', 'mthrow load', 'missing error', 'syntax load', 'depsyntax load', 'depmissing error', 'plain error false']
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
end
