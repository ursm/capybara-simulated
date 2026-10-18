# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame whose `src` names a document a navigable above it has — its own document's or an ancestor's, their fragments
# aside — navigates nowhere (HTML "shared attribute processing steps for iframe and frame elements" step 3, navigables.rs
# `ancestor_document_at`): it keeps its initial about:blank document and fires no `load`. A page that frames itself had
# built a realm for each frame down to the nesting limit, eighteen requests a visit. (Chrome 154 and Firefox compare the
# fragments too, so `src="#x"` of its own page loads once more there; HTML excludes them.)
RSpec.describe 'a frame of a document above it' do
  it 'navigates nowhere, and fires no load' do
    requests = []
    app = lambda {|env|
      requests << env['PATH_INFO']
      body = env['PATH_INFO'] == '/other' ? '<!DOCTYPE html><meta charset=utf-8><p>other' : <<~HTML
        <!DOCTYPE html><meta charset=utf-8><body><script>window.loads = []</script>
        <iframe id=self src="/#x" onload="loads.push('self')"></iframe>
        <iframe id=other src="/other" onload="loads.push('other')"></iframe>
      HTML
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script('[loads, document.getElementById("self").contentDocument.URL, document.getElementById("other").contentDocument.URL]')
    expect(got).to eq([['other'], 'about:blank', 'http://www.example.com/other'])
    expect(requests).to eq(['/', '/other'])
  end
end
