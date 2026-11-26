# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An `async` or inserted script waits for the style sheets that block scripts as it is prepared only while its document's
# parser is at work (script_lists.rs `scriptLandingBegin`, `sheetWaitersParserDone`): HTML's branch for it states no wait
# at all, and where the spec is silent the browsers decide — both wait as the page parses (`rv_css_asy`); past that Firefox
# runs it at once, while Chrome holds DOMContentLoaded itself back until the sheet is in, which HTML does not (it waits
# for no style sheet where no deferred script is left), so Chrome shows nothing of the script's own wait.
RSpec.describe 'an async script and the style sheets blocking scripts' do
  def log_of(head)
    app = ->(env) {
      case env['PATH_INFO']
      when '/a.js' then [200, {'content-type' => 'text/javascript'}, ['R.push("a")']]
      when '/s.css'
        sleep 0.3
        [200, {'content-type' => 'text/css'}, ['p { color: red }']]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><title>t</title><script>window.R = []; addEventListener('DOMContentLoaded', () => R.push('dcl')); addEventListener('load', () => R.push('load'))</script>#{head}"]]
      end
    }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_async_script("const done = arguments[0]; setTimeout(() => done(R.join(' ')), 600)")
  end

  # (…Firefox `dcl ins i.js-ran css load`, Chrome `css dcl ins i.js-ran load`, rv-r13-probe `s4_dclins`)
  it 'runs a script a DOMContentLoaded listener inserts before a sheet still loading' do
    head = '<script>addEventListener("DOMContentLoaded", () => { const s = document.createElement("script"); s.src = "/a.js"; ' \
           'document.head.append(s); R.push("ins") })</script><link rel=stylesheet href="/s.css" onload="R.push(\'css\')">'
    expect(log_of(head)).to eq('dcl ins a css load')
  end

  # (…Firefox `dcl a.js-ran stopped csserr`, Chrome `stopped csserr`, rv-r13-probe `s4_stopasync`: an `async` script held
  # as the page parsed runs as the parser is done, before a `stop()` cancels the sheet — never an `error` for a fetch
  # that came in)
  it 'runs an async script held behind a sheet once the parser is done, before a stop cancels the sheet' do
    head = '<script>setTimeout(() => { stop(); R.push("stopped") }, 50)</script>' \
           '<link rel=stylesheet href="/s.css" onerror="R.push(\'csserr\')"><script async src="/a.js" onerror="R.push(\'a:e\')"></script>'
    expect(log_of(head)).to eq('dcl a stopped csserr')
  end
end
