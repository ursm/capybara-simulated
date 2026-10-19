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

  # A parser marks its script once: one the adoption agency moves after its empty body left it unstarted is prepared by
  # the text set on it, at once. Chrome: ["aa-ran", "after-aa"].
  it "prepares an empty parsed script the parser moved, when text is set on it" do
    html = '<!doctype html><meta charset=utf-8><body><script>window.L = [];</script><b><p><script id=aa></script></b>' \
           "<script>aa.textContent = \"L.push('aa-ran')\"; L.push('after-aa');</script>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script('L')).to eq(%w[aa-ran after-aa])
  end

  # Scripting is disabled for a script whose node document has no browsing context: preparing it marks it "already
  # started" and runs nothing, so it runs no more once moved into the page. Chrome: ["moving", "moved"].
  it 'runs no script prepared in a document without a browsing context' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        window.L = [];
        const hd = document.implementation.createHTMLDocument('');
        const script = hd.createElement('script');
        script.text = "L.push('inert-ran')";
        hd.body.append(script);
        L.push('moving');
        document.body.append(script);
        L.push('moved');
        return L;
      })()
    JS
    expect(got).to eq(%w[moving moved])
  end

  # HTMLScriptElement.supports() answers for the types this UA runs (HTML §4.12.1.1) — the engine's, what it prepares:
  # speculation rules it knows (a script of that type runs nothing) but does not run, so false, where Chrome, which
  # runs them, says true.
  it 'supports the script types it runs' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><body>']] })
    s.visit '/'
    got = s.evaluate_script("['classic', 'module', 'importmap', 'speculationrules', 'text/javascript'].map((t) => HTMLScriptElement.supports(t))")
    expect(got).to eq([true, true, true, false, false])
  end
end
