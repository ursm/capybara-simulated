# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A module script's evaluation that rejects — a top-level throw, a top-level await's — is reported at its window (HTML
# "run a module script": upon rejection, report the exception): an `error` event with the value thrown, which a
# `window.onerror` sees (Chrome: `Uncaught Error: boom` at the document's line), where it reached the console alone.
RSpec.describe 'a module script’s error' do
  include PollUntil

  it 'is reported at its window, a top-level await’s too' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.errs = [];
        window.thrown = new Error('boom');
        onerror = (message, filename, lineno, colno, error) => { errs.push([message, error === thrown || error]); };
      </script>
      <script type="module">throw window.thrown;</script>
      <script type="module">await new Promise((r) => setTimeout(r, 10)); throw 7;</script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(poll_until { (e = s.evaluate_script('errs')).size == 2 && e }).to eq([['Error: boom', true], ['7', 7]])
  end
end
