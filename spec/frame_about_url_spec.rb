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

  # …and a frame whose only `src` is of another namespace has none: about:blank, at its insertion and as its `srcdoc` is
  # removed alike (HTML reads the no-namespace attribute).
  it 'takes an src of another namespace for none, however it comes to navigate' do
    requests = []
    s = simulated_session(->(env) { requests << env['PATH_INFO']; [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const make = (srcdoc) => {
          const frame = document.createElement('iframe');
          frame.setAttributeNS('urn:x', 'src', '/a');
          if (srcdoc) frame.srcdoc = '<p>s</p>';
          document.body.append(frame);
          frame.contentWindow;
          if (srcdoc) frame.removeAttribute('srcdoc');
          return frame.contentDocument.URL;
        };
        return [make(false), make(true)];
      })()
    JS
    expect(got).to eq(%w[about:blank about:blank])
    expect(requests).to eq(['/'])
  end
end
