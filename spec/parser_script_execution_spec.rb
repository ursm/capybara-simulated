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

  # A script a parser-run script INSERTS is not the parser's: it runs once, on insertion (or on its own task, if
  # external) — never again in "the end", which is for the parser's own scripts. A loader snippet's injected script
  # ran twice, and its `load` fired twice. Chrome: each once.
  it 'runs a script inserted during the parse once' do
    app = lambda do |env|
      if env['PATH_INFO'] == '/blk.js'
        [200, {'content-type' => 'text/javascript'}, ["L.push('blk')"]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><head><script>window.L = []; (function () {
            var s = document.createElement('script'); s.src = 'blk.js'; s.onload = function () { L.push('blk-load') }; document.head.appendChild(s);
            var t = document.createElement('script'); t.text = "L.push('inline-dyn')"; document.head.appendChild(t);
          })();</script></head><body><p>x</p></body>
        HTML
      end
    end
    s = simulated_session(app).tap {|session| session.visit '/' }
    expect(s.evaluate_script('L')).to eq(%w[inline-dyn blk blk-load])
  end

  # …and "the end" is for the PARSER's scripts alone: a script an innerHTML fragment made (already started, never
  # runs) or a clone of a started one (the flag is copied) stays inert even when inserted mid-parse — swept up after the
  # parse, both ran. Chrome: neither runs, and the original runs once.
  it 'never runs an innerHTML script or a clone of a started one' do
    s = session_for('<!DOCTYPE html><head><script>window.L = []; const d = document.createElement("div"); ' \
                    'd.innerHTML = "<script>L.push(\'innerHTML\')<\\/script>"; document.head.appendChild(d.firstChild); ' \
                    'const r = document.createElement("script"); r.text = "L.push(\'ran\')"; document.head.appendChild(r); ' \
                    'document.head.appendChild(r.cloneNode(true));</script></head><body><p>x</p></body>')
    expect(s.evaluate_script('L')).to eq(['ran'])
  end

  # The events that PREPARE a connected, not-yet-started script: its children changed — `appendChild`, and setting its
  # `text` / `textContent` — and a `src` set where it had none. Only `appendChild` reached it; the others ran only when
  # the after-parse pass swept them up by accident, and after the parse never. Chrome: all four.
  it 'runs an empty inserted script once its text or src is set' do
    app = lambda do |env|
      next [200, {'content-type' => 'text/javascript'}, ["L.push('src-set')"]] if env['PATH_INFO'] == '/x.js'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><script>window.L = []</script></body>']]
    end
    s = simulated_session(app).tap {|session| session.visit '/' }
    s.execute_script(<<~JS)
      const add = () => document.body.appendChild(document.createElement('script'));
      add().text = "L.push('text')";
      add().textContent = "L.push('textContent')";
      add().appendChild(document.createTextNode("L.push('child')"));
      add().src = 'x.js';
    JS
    s.evaluate_script('new Promise((resolve) => setTimeout(resolve, 50))')
    expect(s.evaluate_script('L')).to eq(%w[text textContent child src-set])
  end

  # An exception a parser-run script throws is REPORTED — `window.onerror` and the window's `error` event — as any
  # other script's is; the parse goes on.
  it 'reports an exception a parser-run script throws' do
    s = session_for('<!DOCTYPE html><head><script>window.L = []; window.onerror = (m, src, l, c, e) => { L.push("onerror:" + e.message) };' \
                    '</script></head><body><script>throw new Error("top")</script><p id="p">after</p></body>')
    expect(s.evaluate_script("[L, !!document.getElementById('p')]")).to eq([['onerror:top'], true])
  end

  # …a COMPILE error as the SyntaxError it is (the engine hands back a plain Error whose message carries its own
  # location), and the event's message as "Name: message" — what Chrome ("Uncaught SyntaxError: …") and Firefox share.
  it 'reports a compile error as a SyntaxError' do
    s = session_for('<!DOCTYPE html><head><script>window.L = []; window.onerror = (m, src, l, c, e) => { ' \
                    'L.push([m, e instanceof SyntaxError, e.message]) };</script></head><body><script>let = = 1;</script></body>')
    expect(s.evaluate_script('L')).to eq([["SyntaxError: Unexpected token '='", true, "Unexpected token '='"]])
  end
end
