# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A module script's evaluation that rejects — a top-level throw, a top-level await's — is reported at its window (HTML
# "run a module script": upon rejection, report the exception), for each script that runs its record: an `error` event
# with the value thrown, which a
# `window.onerror` sees (Chrome: `Uncaught Error: boom` at the document's line), where it reached the console alone.
RSpec.describe 'a module script’s error' do
  include PollUntil

  it 'is reported at its window, a top-level await’s too' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.errs = [];
        window.thrown = new Error('boom');
        onerror = (message, filename, lineno, colno, error) => {
          errs.push([message, error === thrown ? 'thrown' : error instanceof Error ? error.constructor.name : error]);
        };
      </script>
      <script type="module">throw window.thrown;</script>
      <script type="module">await new Promise((r) => setTimeout(r, 10)); throw 7;</script>
      <script type="module" src="/mthrow.js"></script><script type="module" src="/mthrow.js"></script>
    HTML
    s = simulated_session(lambda {|env|
      env['PATH_INFO'] == '/mthrow.js' ? [200, {'content-type' => 'text/javascript'}, ['throw new RangeError("m")']] : [200, {'content-type' => 'text/html'}, [page]]
    })
    s.visit '/'
    # (…a record two scripts run reported for each — Chrome: `RangeError: m` twice)
    expect(poll_until { (e = s.evaluate_script('errs')).size == 4 && e }).to eq([['Error: boom', 'thrown'], ['RangeError: m', 'RangeError'], ['RangeError: m', 'RangeError'], ['7', 7]])
  end
  # …and a graph's error to rethrow alike (HTML "run a module script"): a module that cannot be parsed, a specifier one
  # of its imports names that resolves to none (a bare one no import map maps: a TypeError, nothing fetched), an export
  # none of its modules has — each reported, its kind kept, and the element's `load` fired, not its `error` (a fetch
  # that fails). An `import()` of such a specifier fetches nothing either.
  it 'is its graph’s error to rethrow, reported, for a parse, a resolution and a link' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.errs = [];
        onerror = (message, filename, lineno, colno, error) => { errs.push(`${error.constructor.name}: ${message.split(':')[0]}`); };
        window.ev = (e) => errs.push(`${e.target.id} ${e.type}`);
        window.dyn = import('foo').then(() => 'ok', () => 'rejected');
      </script>
      <script type="module" id="parse" src="/bad.js" onload="ev(event)" onerror="ev(event)"></script>
      <script type="module" id="bare" src="/bare.js" onload="ev(event)" onerror="ev(event)"></script>
      <script type="module" id="link" src="/link.js" onload="ev(event)" onerror="ev(event)"></script>
      <script type="module" id="fetch" src="/missing.js" onload="ev(event)" onerror="ev(event)"></script>
    HTML
    requests = []
    s = simulated_session(lambda {|env|
      requests << env['PATH_INFO']
      js = {
        '/bad.js'  => 'export let x = ;',
        '/ok.js'   => 'export default 1;',
        '/bare.js' => 'import "/ok.js"; import "foo";',
        '/link.js' => 'import { nope } from "/ok.js";'
      }[env['PATH_INFO']]
      next [js ? 200 : 404, {'content-type' => 'text/javascript'}, [js.to_s]] if env['PATH_INFO'].end_with?('.js')

      [200, {'content-type' => 'text/html'}, [page]]
    })
    s.visit '/'
    expect(poll_until { (e = s.evaluate_script('errs')).size == 7 && e }).to eq(
      ['SyntaxError: SyntaxError', 'parse load', 'TypeError: TypeError', 'bare load', 'SyntaxError: SyntaxError', 'link load', 'fetch error']
    )
    expect(s.evaluate_async_script('dyn.then(arguments[0])')).to eq('rejected')
    expect(requests).not_to include('/foo')
  end
  # …at where V8 found it — the module's URL and line, the document's at 0 for a specifier — with no stack of the
  # driver's, an error of the realm's own kind whatever the page put in its place (Chrome: `bad.js`, line 2); and an
  # inline module whose graph cannot be fetched fires `error` as an external one does (HTML "execute the script element").
  it 'is reported where V8 found it, of the realm’s own kind, and fires an inline module’s error' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.seen = [];
        window.SyntaxError = function (m) { window.hijacked = m; };
        onerror = (message, filename, lineno, colno, error) => {
          seen.push([error instanceof Object.getPrototypeOf(RangeError.prototype).constructor, error.name, filename.replace(location.origin, ''), lineno, error.stack]);
        };
      </script>
      <script type="module" src="/bad.js"></script>
      <script type="module" src="/bare.js"></script>
      <script type="module" onerror="seen.push('inline error')">import "/missing.js";</script>
    HTML
    s = simulated_session(lambda {|env|
      js = {'/bad.js' => "1;\nexport let x = ;", '/bare.js' => 'import "foo";'}[env['PATH_INFO']]
      next [js ? 200 : 404, {'content-type' => 'text/javascript'}, [js.to_s]] if env['PATH_INFO'].end_with?('.js')

      [200, {'content-type' => 'text/html'}, [page]]
    })
    s.visit '/'
    expect(poll_until { (e = s.evaluate_script('seen')).size == 3 && e }).to eq(
      [
        [true, 'SyntaxError', '/bad.js', 2, "SyntaxError: Unexpected token ';'"],
        [true, 'TypeError', '/', 0, %(TypeError: #{Capybara::Simulated::RuntimeShared.unresolved_specifier('foo')})],
        'inline error'
      ]
    )
    expect(s.evaluate_script('window.hijacked')).to be_nil
  end
end
