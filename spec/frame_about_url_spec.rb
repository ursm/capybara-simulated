# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame at an about: URL other than about:blank itself — `about:blank#x`, `about:srcdoc` — loads an empty document
# without a fetch (Fetch's scheme fetch: about:blank an empty document, any other about: URL a network error): it had
# gone to the host as a navigation request, which the host could not make of it.
RSpec.describe 'a frame at an about: URL' do
  it 'loads an empty document, asking the host for nothing' do
    requests = []
    page = %(<!DOCTYPE html><meta charset=utf-8><body><iframe id=a src="about:blank#x"></iframe><iframe id=b src="ABOUT:blank"></iframe>)
    s = simulated_session(->(env) { requests << env['PATH_INFO']; [200, {'content-type' => 'text/html'}, [page]] })
    got = nil
    expect {
      s.visit '/'
      got = s.evaluate_script('["a", "b"].map((id) => { const d = document.getElementById(id).contentDocument; return [d.URL, d.body ? d.body.childNodes.length : -1]; })')
    }.not_to output(/host fn error/).to_stderr
    expect(got).to eq([['about:blank#x', 0], ['about:blank', 0]])
    expect(requests).to eq(['/'])
  end
end
