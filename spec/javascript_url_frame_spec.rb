# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A `javascript:` URL frame's script runs in the frame's initial about:blank document (HTML "evaluate a javascript:
# URL"): its URL is about:blank, and its base URL its creator's, so a relative URL there resolves against the parent.
RSpec.describe 'a javascript: URL' do
  include PollUntil

  it 'runs in an about:blank document of its creator’s base URL' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
        window.got = null;
        document.body.appendChild(document.createElement('iframe')).src =
          "javascript:parent.got = [document.URL, location.href, document.baseURI]";
      </script>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/dir/p.html'
    expect(poll_until { s.evaluate_script('window.got') }).to eq(['about:blank', 'about:blank', 'http://www.example.com/dir/p.html'])
  end

  # …and one navigated to a javascript: URL from a document it has runs it in THAT document (Chrome: a non-string result
  # leaves it, `A`; a string one replaces it at that document's URL, `JS2`), as no new document begins.
  it 'runs in the document a frame has, a string result replacing it at its URL' do
    app = lambda {|env|
      body = env['PATH_INFO'] == '/dir/a.html' ? '<!DOCTYPE html><meta charset="utf-8"><body>A' : <<~HTML
        <!DOCTYPE html><meta charset="utf-8"><body><iframe src="a.html"></iframe><script>
          window.got = [];
          const f = document.querySelector('iframe');
          f.onload = () => {
            f.onload = () => got.push([f.contentWindow.location.href, f.contentDocument.baseURI, f.contentDocument.body.textContent]);
            f.src = "javascript:parent.got.push([location.href, document.body.textContent]); void 0";
            setTimeout(() => { f.src = "javascript:'<p>JS2</p>'"; }, 50);
          };
        </script>
      HTML
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/dir/p.html'
    a = 'http://www.example.com/dir/a.html'
    expect(poll_until { (g = s.evaluate_script('window.got')).size == 2 && g }).to eq([[a, 'A'], [a, a, 'JS2']])
  end

  # …its source a classic script, as a `<script>`'s: a top-level `let` the global's wherever it sits, a `var` too, and a
  # lexical source's string result replacing the frame's document all the same (Chrome: `number` for each, from a link
  # of the top-level page; `LEX`).
  it 'runs its source as a classic script, its declarations global' do
    app = lambda {|env|
      body = case env['PATH_INFO']
             when '/a.html' then '<!DOCTYPE html><meta charset="utf-8"><body>A'
             else '<!DOCTYPE html><meta charset="utf-8"><a id=a href="javascript:document.title = \'t\'; let mx = 1; var vx = 2; void 0">a</a><iframe src="/a.html"></iframe>'
             end
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/'
    s.find('#a').click
    expect(poll_until { (t = s.evaluate_script('[typeof mx, typeof vx]')) == %w[number number] && t }).to eq(%w[number number])
    s.execute_script(%q{document.querySelector('iframe').src = "javascript:let lx = 1; '<p>LEX</p>'"})
    expect(poll_until { (t = s.evaluate_script("document.querySelector('iframe').contentDocument.body.textContent")) == 'LEX' && t }).to eq('LEX')
  end

  # …and a window the page opened, its `location` set to one by the opener, evaluates it in ITS document — of the
  # opener's origin — rather than navigating to a URL of that text resolved as a relative one.
  it 'runs in the document of a window the page opened' do
    app = ->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/a.html' ? '<!DOCTYPE html><meta charset="utf-8"><body>A' : '<!DOCTYPE html><meta charset="utf-8"><body>main']] }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(%q{window.pop = open('/a.html'); setTimeout(() => { pop.location.href = "javascript:var popv = 7; void 0"; }, 50);})
    s.has_css?('#none', wait: 0.5)
    s.switch_to_window(s.windows.last)
    expect(poll_until { (t = s.evaluate_script('typeof popv')) == 'number' && t }).to eq('number')
    expect(s.current_url).to eq('http://www.example.com/a.html')
  end
end
