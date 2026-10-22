# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# XHR open() parses its URL against the API base URL, and a URL that does not parse is a SyntaxError: a relative one in a
# blob: worker, whose base is the blob: URL (Chrome: open('GET', '/x') throws SyntaxError there), where an absolute one
# opens.
RSpec.describe 'XHR open()’s URL' do
  include PollUntil

  it 'throws for a relative URL against a blob: worker’s base' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      window.got = null;
      const src = `onmessage = () => postMessage(['/x', location.origin + '/x'].map((u) => {
        try { new XMLHttpRequest().open('GET', u); return 'opened'; } catch (e) { return e.name; }
      }));`;
      const w = new Worker(URL.createObjectURL(new Blob([src])));
      w.onmessage = (e) => { window.got = e.data; };
      w.postMessage(0);
    JS
    expect(poll_until { s.evaluate_script('window.got') }).to eq(%w[SyntaxError opened])
  end
end
