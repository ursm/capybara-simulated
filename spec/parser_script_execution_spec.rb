# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# The scripts a PARSE runs: when (against `readyState`), which (`nomodule`), and what happens to their exceptions.
# Every expectation is Chrome's.
RSpec.describe 'scripts the parser runs' do
  def session_for(html, type: 'text/html')
    simulated_session(->(_env) { [200, {'content-type' => type}, [html]] }).tap {|s| s.visit '/' }
  end

  # The XML parser hands no script to a handler, so the after-parse pass runs them all — the parser-blocking ones
  # first, while the document is still 'loading', and only then "the end" makes it 'interactive'. Moving that
  # transition ahead of every script made them all see 'interactive', and a head listener never saw the change.
  it "runs an XHTML document's scripts while it is loading" do
    s = session_for(<<~XHTML, type: 'application/xhtml+xml')
      <html xmlns="http://www.w3.org/1999/xhtml"><head><script>
        window.L = ['head:' + document.readyState];
        document.addEventListener('readystatechange', () => L.push('rsc:' + document.readyState));
        document.addEventListener('DOMContentLoaded', () => L.push('DCL'));
      </script></head><body><p>a</p><script>L.push('body:' + document.readyState)</script></body></html>
    XHTML
    expect(s.evaluate_script('L')).to eq(%w[head:loading body:loading rsc:interactive DCL rsc:complete])
  end

  # A classic script marked `nomodule` does not run where modules are supported — parsed, or inserted by script —
  # which is the other half of differential serving.
  it 'does not run a nomodule classic script' do
    s = session_for('<!DOCTYPE html><body><script>window.L = []</script><script nomodule>L.push("parsed")</script>' \
                    '<script>const s = document.createElement("script"); s.noModule = true; s.textContent = "L.push(\'dynamic\')"; ' \
                    'document.body.appendChild(s); L.push("end")</script></body>')
    expect(s.evaluate_script('L')).to eq(['end'])
  end

  # An exception a parser-run script throws is REPORTED — `window.onerror` and the window's `error` event — as any
  # other script's is; the parse goes on.
  it 'reports an exception a parser-run script throws' do
    s = session_for('<!DOCTYPE html><head><script>window.L = []; window.onerror = (m, src, l, c, e) => { L.push("onerror:" + e.message) };' \
                    '</script></head><body><script>throw new Error("top")</script><p id="p">after</p></body>')
    expect(s.evaluate_script("[L, !!document.getElementById('p')]")).to eq([['onerror:top'], true])
  end
end
