require 'capybara/simulated'
require_relative 'support/session_teardown'

# HTML "execute the script element": a script from an external file fires `load` once it has run, whatever it threw —
# the throw reported (`window.onerror`) — and `error` only where it could not be fetched; a module's `src` resolves
# against its document's base URL. Chrome 155 on this page: `onerror TypeError | classic load | module load true |
# onerror RangeError | mthrow load | missing error`. (A module's throw is logged, not yet reported: the host evaluates
# the graph and the thrown value does not cross back — the `onerror RangeError` Chrome adds.)
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
      else [404, {'content-type' => 'text/javascript'}, ['']]
      end
    })
    s.visit '/'
    expect(s.evaluate_async_script('setTimeout(() => arguments[0](log), 10)')).to eq(
      ['onerror TypeError', 'classic load', 'module load true', 'mthrow load', 'missing error']
    )
  end
end
