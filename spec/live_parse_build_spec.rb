# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A page's parse is built by the engine batch by batch, between the scripts it stops for (html_parse.rs
# `htmlRunBuilt`), and replayed by the bindings where a batch needs them (a custom element, a `<details>`): what a
# script sees of the page so far, what it writes in, the page's own `<html>` / `<head>` / `<body>` kept, its mode, its
# handlers, its template contents' scripts and the records an observer has of it are the same either way (Chrome's).
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

  observed = <<~HTML
    <!DOCTYPE html><html><head><script>
      window.seen = [];
      new MutationObserver((records) => {
        for (const r of records) seen.push(r.target.nodeName + '+' + [...r.addedNodes].map((n) => n.nodeName).join(',') +
          '<' + (r.previousSibling ? r.previousSibling.nodeName : '') + '>' + (r.nextSibling ? r.nextSibling.nodeName : ''));
      }).observe(document, {childList: true, subtree: true});
    </script></head><body><p>a<b>b</b></p><table><tr><td>x</td></tr>t</table><script>window.mid = seen.length</script>
    <ul><li>1<li>2</ul></body></html>
  HTML

  it 'queues the records of its insertions for an observer the page made, in order' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [observed]] }).tap {|s| s.visit '/' }
    expect(session.evaluate_script('[window.mid, window.seen]')).to eq([
      13,
      [
        'HTML+BODY<HEAD>', 'BODY+P<>', 'P+#text<>', 'P+B<#text>', 'B+#text<>', 'BODY+TABLE<P>', 'TABLE+TBODY<>', 'TBODY+TR<>',
        'TR+TD<>', 'TD+#text<>', 'BODY+#text<P>TABLE', 'BODY+SCRIPT<TABLE>', 'SCRIPT+#text<>', 'BODY+#text<SCRIPT>',
        'BODY+UL<#text>', 'UL+LI<>', 'LI+#text<>', 'UL+LI<LI>', 'LI+#text<>', 'BODY+#text<UL>'
      ]
    ])
  end

  # A second `<body>` or `<html>` start tag adds the attributes its element has not got, each queuing an attribute record
  # in the token's order (DOM "append an attribute"); Chrome: `BODY.id BODY.class HTML.lang`.
  it 'records the attributes a second body or html tag adds' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
      window.seen = [];
      new MutationObserver((rs) => { for (const r of rs) if (r.type === 'attributes') seen.push(r.target.nodeName + '.' + r.attributeName); })
        .observe(document, {attributes: true, subtree: true});
      </script><body><p>x</p><body id=b2 class=c><html lang=en>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
    expect(session.evaluate_script('[window.seen, document.body.id, document.documentElement.lang]')).to eq([%w[BODY.id BODY.class HTML.lang], 'b2', 'en'])
  end

  # A custom element whose name holds a lone surrogate is constructed at its start tag, as any other — empty, its
  # attributes and children still to come (Firefox `ctor:0:0`; Chrome crashes on the page).
  it 'constructs a custom element named with a lone surrogate at its start tag' do
    page = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><body><script>
      window.log = [];
      customElements.define('x-\\uD800', class extends HTMLElement { constructor() { super(); log.push(this.childNodes.length + ':' + this.attributes.length); } });
      document.write('<x-\\uD800 id=q a=1>kid</x-\\uD800>');
      </script>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
    expect(session.evaluate_script("[window.log, document.getElementById('q').constructor === customElements.get('x-\\uD800')]")).to eq([['0:0'], true])
  end
end
