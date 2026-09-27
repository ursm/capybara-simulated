# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A fetched style sheet is one only where it is served as `text/css` — HTML "process the linked resource" for
# `rel=stylesheet`, and CSS Cascade's `@import` — unless the document is in quirks mode and the sheet is same-origin,
# where the type is ignored. Applied whatever its type, a page whose `@import` a catch-all app answered with the page
# itself cascaded the page's HTML as 16,900 rules. Measured (a `text/plain` sheet): Chrome and Firefox apply neither in
# a standards-mode document and both in a quirks-mode one. The link's event is the spec's `error` and Firefox's; Chrome
# fires `load` for a sheet it refuses to apply, a Blink quirk.
RSpec.describe 'a stylesheet served as something other than CSS' do
  def outcome(doctype:, type:)
    app = lambda {|env|
      case env['PATH_INFO']
      when '/x.css' then [200, {'content-type' => type}, ['p { display: none }']]
      when '/i.css' then [200, {'content-type' => type}, ['q { display: none }']]
      else
        [200, {'content-type' => 'text/html'}, ["#{doctype}<html><head><link rel=\"stylesheet\" href=\"/x.css\" " \
                                               "onload=\"window.L = 'load'\" onerror=\"window.L = 'error'\">" \
                                               '<style>@import url(/i.css);</style></head><body><p id="p">x</p><q id="q">y</q></body></html>']]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    s.evaluate_script("[window.L, getComputedStyle(document.getElementById('p')).display, getComputedStyle(document.getElementById('q')).display]")
  end

  it 'applies one served as text/css' do
    expect(outcome(doctype: '<!DOCTYPE html>', type: 'text/css; charset=utf-8')).to eq(%w[load none none])
  end

  it 'applies none served as anything else in a standards-mode document' do
    expect(outcome(doctype: '<!DOCTYPE html>', type: 'text/plain')).to eq(%w[error block inline])
    expect(outcome(doctype: '<!DOCTYPE html>', type: 'text/html')).to eq(%w[error block inline])
  end

  it 'applies a same-origin one whatever its type in a quirks-mode document' do
    expect(outcome(doctype: '', type: 'text/plain')).to eq(%w[load none none])
  end
end
