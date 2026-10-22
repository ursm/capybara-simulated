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
end
