# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A page's parse is built by the engine batch by batch, between the scripts it stops for (html_parse.rs
# `htmlRunBuilt`), and replayed by the bindings where a batch needs them (a custom element, an observer, a
# `<details>`): what a script sees of the page so far, what it writes in, the page's own `<html>` / `<head>` / `<body>`
# kept, its mode, its handlers and its template contents' scripts are the same either way.
RSpec.describe 'a page parse the engine builds' do
  page = <<~HTML
    <html lang=en class=p><head><title>t</title>
    <script>window.log = [document.body === null, document.querySelectorAll('*').length];</script>
    </head><body data-x=1 onload="window.loaded = 1">
    <p id=a>one</p>
    <script>log.push(document.getElementById('a').textContent); document.write('<p id=w>written</p>');</script>
    <template><script>window.ran = 1</script><p>in</p></template>
    <button onclick="window.hit = 1">b</button>
    <script>log.push(document.getElementById('w').previousElementSibling.nodeName);</script>
    <details name=n open></details><details name=n open></details>
    </body></html>
  HTML

  it 'gives the scripts the page so far, keeps its skeleton, and runs no template script' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
    got = session.evaluate_script(<<~'JS')
      (() => {
        document.querySelector('button').click();
        const t = document.querySelector('template');
        return [
          window.log, document.compatMode, document.documentElement.lang, document.documentElement.className,
          document.body.dataset.x, window.loaded, window.hit, window.ran === undefined, t.content.children.length,
          t.content.firstChild.ownerDocument !== document, [...document.querySelectorAll('details')].map((d) => d.open)
        ];
      })()
    JS
    expect(got).to eq([
      [true, 4, 'one', 'SCRIPT'], 'BackCompat', 'en', 'p', '1', 1, 1, true, 2, true, [true, false]
    ])
  end
end
