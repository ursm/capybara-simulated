# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's readiness is `complete` in the task that fires its load (HTML "the end": once nothing delays the load
# event), so a subresource that delays it — a style sheet — loads while the document is not yet complete (Chrome:
# `link:loading rsc:interactive dcl:interactive … rsc:complete load:complete`, the sheet's load during the parse there).
RSpec.describe 'document readiness' do
  let(:page) {
    <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.log = [];
        document.addEventListener('readystatechange', () => log.push('rsc:' + document.readyState));
        document.addEventListener('DOMContentLoaded', () => log.push('dcl:' + document.readyState));
        addEventListener('load', () => log.push('load:' + document.readyState));
      </script><link rel=stylesheet href="/s.css" onload="log.push('link:' + document.readyState)">
    HTML
  }

  it 'turns complete only as the load fires, after the sheets that delay it' do
    s = simulated_session(->(env) { env['PATH_INFO'] == '/s.css' ? [200, {'content-type' => 'text/css'}, ['p{color:red}']] : [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    log = s.evaluate_script('log')
    expect(log.last(2)).to eq(%w[rsc:complete load:complete])
    expect(log.grep(/\Alink:/)).to contain_exactly(a_string_matching(/\Alink:(loading|interactive)\z/))
  end
end
