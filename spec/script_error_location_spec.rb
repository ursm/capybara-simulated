# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An exception an external script throws is reported at its script's URL, resolved — the file an `ErrorEvent` names
# (Chrome: `http://…/js/a.js`) — at the line and column of its own frame, whatever a page named the function it threw
# from, however large the script; and an asynchronous script that never calls back is a timeout, not a nil answer.
RSpec.describe 'script error locations' do
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/js/a.js'
        [200, {'content-type' => 'text/javascript'}, ["var f = { ['a(b']() { throw new Error('x'); } };\nf['a(b']();\n"]]
      when '/js/big.js', '/js/big-syntax.js'
        # Past the bytecode cache's 64 KB threshold, so it runs by the cached path rather than an eval.
        tail = env['PATH_INFO'] == '/js/big.js' ? "throw window.bigError = new Error('big');\n" : "var = ;\n"
        [200, {'content-type' => 'text/javascript'}, ["var pad = 0;\n#{'// pad' * 12_000}\n#{tail}"]]
      when '/big'
        page = <<~HTML
          <!DOCTYPE html><meta charset="utf-8">
          <script>
            window.seen = [];
            addEventListener('error', (e) => {
              seen.push([e.filename, e.lineno, e.error?.name, e.error === window.bigError || e.error === window.lexicalError]);
            });
          </script>
          <script src="js/big.js"></script>
          <script src="js/big-syntax.js"></script>
          <script>const lexical = 1; throw window.lexicalError = new TypeError('lexical');</script>
        HTML
        [200, {'content-type' => 'text/html'}, [page]]
      else
        page = <<~HTML
          <!DOCTYPE html><meta charset="utf-8">
          <script>window.seen = null; addEventListener('error', (e) => { seen = [e.filename, e.lineno, e.colno]; });</script>
          <script src="js/a.js"></script>
        HTML
        [200, {'content-type' => 'text/html'}, [page]]
      end
    }
  }

  it 'reports an external script’s exception at its resolved URL and its own frame' do
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('seen')).to eq(['http://www.example.com/js/a.js', 1, 29])
  end

  it 'reports a large external script’s exception and syntax error, and a lexical one’s, as a small one’s' do
    s = simulated_session(app)
    s.visit '/big'
    big, syntax, lexical = s.evaluate_script('seen')
    # (…the value the script threw, as the error a small one reports is: not a copy the driver made of its text)
    expect(big).to eq(['http://www.example.com/js/big.js', 3, 'Error', true])
    # (A parse error's own location is the engine's message, not a stack frame, and no path reads it yet — a small
    # script's is as bare.)
    expect(syntax[2]).to eq('SyntaxError')
    # …and one that opens with a lexical declaration, which runs by the realm's top-level eval
    expect(lexical).to eq(['http://www.example.com/big', 1, 'TypeError', true])
  end

  it 'raises a script timeout where an asynchronous script never calls back' do
    s = simulated_session(app)
    s.visit '/'
    Capybara.using_wait_time(0.2) do
      expect { s.evaluate_async_script('/* no callback */') }.to raise_error(Capybara::Simulated::ScriptTimeoutError)
    end
  end
end
