require 'capybara/simulated'
require_relative 'support/session_teardown'

# The platform parses its URLs natively (url-parse.js `parseURL`), never through the `URL` class a page can replace — a
# URL polyfill installs its own, and a page may poison it: a fetch, an XHR, `history.pushState`, a hyperlink's `href`
# components and a Request all still resolve as the URL Standard says.
RSpec.describe 'a page that replaces URL' do
  it 'parses the platform URLs regardless' do
    s = simulated_session(->(env) {
      next [200, {'content-type' => 'text/plain'}, ["got #{env['PATH_INFO']}"]] if env['PATH_INFO'] != '/'
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><a id="a" href="/p/q?x=1#h">a</a>']]
    })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      window.URL = function () { throw new Error('poisoned'); };
      const out = [];
      const a = document.getElementById('a');
      out.push(a.pathname, a.search, a.hash);
      a.search = '?y=2';
      out.push(a.getAttribute('href'));
      history.pushState(null, '', '/pushed');
      out.push(location.pathname);
      out.push(new Request('/r').url);
      const x = new XMLHttpRequest();
      x.open('GET', '/xhr', false);
      x.send();
      out.push(x.responseText);
      fetch('/f').then(r => r.text()).then(t => { out.push(t); done(out); }, e => done(String(e)));
    JS
    expect(got).to eq(['/p/q', '?x=1', '#h', 'http://www.example.com/p/q?y=2#h', '/pushed', 'http://www.example.com/r', 'got /xhr', 'got /f'])
  end
end
