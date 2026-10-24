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
end
