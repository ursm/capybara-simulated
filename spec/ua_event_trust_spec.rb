require 'capybara/simulated'
require_relative 'support/session_teardown'

# The events the UA fires itself are trusted, and are dispatched by its steps — not through a `dispatchEvent` a page
# may have replaced, which reports them untrusted (HTML "fire an event"): a fragment navigation's `hashchange`, a
# history traversal's `popstate`, a frame's `load`, an image's `error` — and `unhandledrejection` reaches
# `onunhandledrejection` once, as one of the window's listeners.
RSpec.describe 'UA-fired events' do
  let(:app) {
    lambda do |env|
      next [404, {}, ['']] unless env['PATH_INFO'] == '/'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <iframe id=f srcdoc="<p>x"></iframe><img id=i src="/missing.png">
          <script>
            window.__trust = {};
            window.dispatchEvent = () => { throw new Error('the page\\'s dispatchEvent'); };
            addEventListener('hashchange', (e) => { __trust.hashchange = e.isTrusted; });
            addEventListener('popstate', (e) => { __trust.popstate = e.isTrusted; });
            document.getElementById('f').addEventListener('load', (e) => { __trust.frameLoad = e.isTrusted; });
            document.getElementById('i').addEventListener('error', (e) => { __trust.imageError = e.isTrusted; });
            __trust.unhandled = 0;
            window.onunhandledrejection = (e) => { __trust.unhandled++; e.preventDefault(); };
            Promise.reject(new Error('x'));
            location.hash = '#a';
            history.pushState({}, '', '#b');
            history.back();
          </script>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  it 'fires them trusted, by the steps' do
    session.visit '/'
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 200))')
    expect(session.evaluate_script('window.__trust')).to eq(
      'hashchange' => true, 'popstate' => true, 'frameLoad' => true, 'imageError' => true, 'unhandled' => 1
    )
  end
end
