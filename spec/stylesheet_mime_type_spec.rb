# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A fetched style sheet is one only where it is served as `text/css` — HTML "process the linked resource" for
# `rel=stylesheet`, and CSS Cascade's `@import` — unless the document is in quirks mode and the sheet is same-origin,
# where the type is ignored. Applied whatever its type, a page whose `@import` a catch-all app answered with the page
# itself cascaded the page's HTML as 16,900 rules. Measured (a `text/plain` sheet): Chrome and Firefox apply neither in
# a standards-mode document and both in a quirks-mode one, and expose each as a sheet with no rules. The link's event is
# the spec's `error` and Firefox's; Chrome fires `load` for a sheet it refuses to apply, a Blink quirk. A sheet served
# with NO type both apply (as `application/x-unknown-content-type`, what a missing header is sniffed as).
RSpec.describe 'a stylesheet served as something other than CSS' do
  def outcome(doctype:, type:, back: false)
    headers = type ? {'content-type' => type} : {}
    via = back ? 'http://other.test' : ''
    app = lambda {|env|
      case [env['SERVER_NAME'], env['PATH_INFO']]
      in ['other.test', path] then [302, {'location' => "http://www.example.com#{path}"}, []]
      in [_, '/x.css'] then [200, headers, ['p { display: none }']]
      in [_, '/i.css'] then [200, headers, ['q { display: none }']]
      else
        [200, {'content-type' => 'text/html'}, ["#{doctype}<html><head><link rel=\"stylesheet\" href=\"#{via}/x.css\" " \
                                               "onload=\"window.L = 'load'\" onerror=\"window.L = 'error'\">" \
                                               "<style>@import url(#{via}/i.css);</style></head><body><p id=\"p\">x</p><q id=\"q\">y</q></body></html>"]]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    s.evaluate_script(<<~JS)
      (() => {
        const rules = (sheet) => { try { return sheet.cssRules.length; } catch (e) { return e.name; } };
        return [window.L, getComputedStyle(document.getElementById('p')).display, getComputedStyle(document.getElementById('q')).display,
                rules(document.querySelector('link').sheet), rules(document.querySelector('style').sheet.cssRules[0].styleSheet)];
      })()
    JS
  end

  it 'applies one served as text/css, or as no type at all' do
    ['text/css; charset=utf-8', nil, 'application/x-unknown-content-type'].each do |type|
      expect(outcome(doctype: '<!DOCTYPE html>', type:)).to eq(['load', 'none', 'none', 1, 1]), type.inspect
    end
  end

  it 'applies none served as anything else in a standards-mode document, and exposes each with no rules' do
    expect(outcome(doctype: '<!DOCTYPE html>', type: 'text/plain')).to eq(['error', 'block', 'inline', 0, 0])
    expect(outcome(doctype: '<!DOCTYPE html>', type: 'text/html')).to eq(['error', 'block', 'inline', 0, 0])
  end

  it 'applies a same-origin one whatever its type in a quirks-mode document' do
    expect(outcome(doctype: '', type: 'text/plain')).to eq(['load', 'none', 'none', 1, 1])
  end

  # (…a CORS-same-origin one: one another origin's URL redirected back to the document's is no such response — HTML's
  # "the resource is CORS-same-origin", a no-cors response tainted by the hop — whatever its final URL says)
  it 'applies none another origin redirected to it, in a quirks-mode document' do
    prev = ENV['CSIM_LOCAL_ALL_HOSTS']
    ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'   # the other origin served in-process
    expect(outcome(doctype: '', type: 'text/plain', back: true)).to eq(%w[error block inline SecurityError SecurityError])
  ensure
    ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
  end
end
