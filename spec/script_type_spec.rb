# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A script element's type (HTML "prepare the script element" steps 8-12) is the engine's (script.rs): its `type`, else
# `text/` and its `language`, its whitespace stripped, then a JavaScript MIME type essence — any of the sixteen, with no
# parameter — a classic script; an empty `type` one too, whatever its `language`. Parsed and inserted alike.
RSpec.describe 'script element types' do
  it 'runs the scripts whose type is a JavaScript MIME type essence' do
    html = <<~HTML
      <!doctype html><meta charset=utf-8><body><script>window.ran = [];</script>
      <script type="text/jscript">ran.push('jscript')</script>
      <script type=" text/javascript ">ran.push('spaced')</script>
      <script type="text/javascript; charset=utf-8">ran.push('param')</script>
      <script language="JavaScript1.5">ran.push('lang15')</script>
      <script language="vbscript">ran.push('vbs')</script>
      <script type="" language="vbscript">ran.push('emptytype')</script>
      <script type="application/x-ecmascript">ran.push('x-ecma')</script>
      <script type="text/livescript">ran.push('livescript')</script>
      <script>
        for (const t of ['text/jscript', ' text/javascript ', 'text/javascript; charset=utf-8', 'text/plain']) {
          const s = document.createElement('script'); s.type = t; s.text = "ran.push('dyn:" + t.trim() + "')"; document.body.append(s);
        }
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    # Chrome: the same, in the same order.
    expect(s.evaluate_script('ran')).to eq(%w[jscript spaced lang15 emptytype x-ecma livescript dyn:text/jscript dyn:text/javascript])
  end
end
