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
    # (…a parse error at the place in its text that did not compile: the engine's message, not a stack frame)
    expect(syntax[0, 3]).to eq(['http://www.example.com/js/big-syntax.js', 3, 'SyntaxError'])
    # …and one that opens with a lexical declaration, which runs by the realm's top-level eval
    expect(lexical).to eq(['http://www.example.com/big', 10, 'TypeError', true])
  end

  # …and an inline script's at the line of its document, counted from where the parser began its text (Chrome: 6 and 3
  # below) — one a script inserted, from its own first line. (The column on its first line is its own, not past its
  # start tag: the tokenizer counts no columns.)
  it 'reports an inline script’s exception at its document’s line' do
    page = <<~HTML
      <!DOCTYPE html>
      <script>window.seen = []; onerror = (m, f, l, c) => { seen.push([l, c]); };</script>
      <p>a</p>

      <script>
        null.x;
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s.execute_script("const s = document.createElement('script'); s.text = '\\n\\nnull.z'; document.body.append(s)")
    expect(s.evaluate_script('seen')).to eq([[6, 8], [3, 6]])
  end

  # …the lines `document.write` put in none of the document's (Chrome, Firefox: 6 below), and a script of a fragment
  # counted from its own first line, whatever the markup before it (Chrome, Firefox: 3)
  it 'counts no written line, nor a fragment’s, as the document’s' do
    page = <<~HTML
      <!DOCTYPE html>
      <script>window.seen = []; onerror = (m, f, l) => { seen.push(l); };</script>
      <script>document.write('<p>\\n\\n\\n</p>')</script>
      <p>x</p>
      <p>y</p>
      <script>null.a</script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s.execute_script(<<~JS)
      const r = document.createRange();
      r.selectNodeContents(document.body);
      document.body.append(r.createContextualFragment('<p>\\n\\n</p><script>\\n\\nnull.b</script>'));
    JS
    expect(s.evaluate_script('seen')).to eq([6, 3])
  end

  # …nor the parser's line to an empty script it made, its text given later: that text the parser's no more than an
  # inserted script's is, counted from its own first line (Chrome: 3)
  it 'counts a parser script’s later text from its own first line' do
    page = <<~HTML
      <!DOCTYPE html>
      <script>window.seen = []; onerror = (m, f, l) => { seen.push(l); };</script>
      <p>x</p>

      <script id="s"></script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    s.execute_script("document.getElementById('s').textContent = '\\n\\nnull.c'")
    expect(s.evaluate_script('seen')).to eq([3])
  end

  # …and an Error whose `stack` getter throws is reported all the same, at where it was thrown: a browser's report
  # consults no page getter.
  it 'reports an exception whose stack getter throws' do
    page = <<~HTML
      <!DOCTYPE html><script>window.seen = []; onerror = (m, f, l, c, e) => { seen.push([m, l, c, !!e]); };</script>
      <script>const e = new Error('x'); Object.defineProperty(e, 'stack', {get() { throw 1 }}); throw e;</script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    expect(s.evaluate_script('seen')).to eq([['Error: x', 2, 11, true]])
  end

  it 'raises a script timeout where an asynchronous script never calls back' do
    s = simulated_session(app)
    s.visit '/'
    Capybara.using_wait_time(0.2) do
      expect { s.evaluate_async_script('/* no callback */') }.to raise_error(Capybara::Simulated::ScriptTimeoutError)
    end
  end
end
