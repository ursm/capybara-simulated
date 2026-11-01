# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A classic `<script>` runs as an ECMA-262 Script of its realm (HTML "run a classic script" → ScriptEvaluation): its
# top-level `var` and function declarations are properties of the global object, its `let` / `const` / `class` live in
# the global lexical environment every later script of the realm shares — wherever in its text they sit, a strict one's
# too — and a declaration that collides with one already there is a SyntaxError GlobalDeclarationInstantiation throws
# before any of the script runs, reported where its text begins. What it throws is reported at its URL and line, and
# `document.currentScript` is it while it runs. Every expectation is Chrome 156's, measured 2026-11-01.
RSpec.describe 'a classic script' do
  page = <<~HTML
    <!DOCTYPE html><meta charset=utf-8>
    <script>
    var log = []; onerror = (m, f, l) => { log.push(m.replace(/^Uncaught /, '') + ' @' + l); };
    </script>
    <script>
    log.push('a'); const MID = 1; let midLet = 2; class MidClass {}
    function f7fn() {} var f7var = 3;
    </script>
    <script>
    log.push([MID, midLet, typeof MidClass, typeof window.f7fn, window.f7var, document.currentScript.tagName].join(' '));
    "use strict"; var strictVar = 4;
    </script>
    <script>
    log.push('never'); let MID = 5;
    </script>
    <script>
    log.push('MID ' + MID + ' strictVar ' + window.strictVar);
    </script>
    <script>
      throw new Error('boom');
    </script>
    <script>
      this is a syntax error
    </script>
  HTML

  it "shares the realm's global lexical environment and refuses a redeclaration whole" do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    expect(session.evaluate_script('log')).to eq(
      [
        'a',
        '1 2 function function 3 SCRIPT',
        "SyntaxError: Identifier 'MID' has already been declared @13",
        'MID 1 strictVar 4',
        'Error: boom @20',
        "SyntaxError: Unexpected identifier 'is' @23"
      ]
    )
  end
end
