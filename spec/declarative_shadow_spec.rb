# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# Declarative shadow roots, as the HTML parser attaches them (html_parse.rs `attach_declarative_shadow`): at the
# template's START tag, its children then parsed straight into the shadow root. Every expectation is Chrome's.
RSpec.describe 'declarative shadow roots' do
  def session_for(html)
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  # The shadow root is there from the start tag on, and a script in it runs where the parser reaches it, connected —
  # its `currentScript` null, as in any shadow tree. Converted at `</template>`, the content sat in the template's inert
  # contents until then, and a script in it waited for the conversion.
  it 'parses the content straight into the shadow root' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><div id=h><template shadowrootmode=OPEN><span>in</span><script>
        window.seen = [document.getElementById('h').shadowRoot.childNodes.length, document.currentScript, document.getElementById('h').shadowRoot.mode];
      </script><slot></slot></template><b>light</b></div>
    HTML
    expect(s.evaluate_script('seen')).to eq([2, nil, 'open'])
    expect(s.evaluate_script("document.getElementById('h').shadowRoot.childNodes.length")).to eq(3)
    expect(s.evaluate_script("document.getElementById('h').innerHTML")).to eq('<b>light</b>')
  end

  # Where the host takes none, the template is one like any other, where the parser has it: after a first shadow root,
  # in the host; as a template's child, in that template's contents. A host in template contents takes one too, which a
  # clone of it keeps (`shadowrootclonable`).
  it 'inserts a template whose host takes no shadow root' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><span id=d><template shadowrootmode=open>1</template><template shadowrootmode=closed>2</template></span>
      <template id=outer><div id=c><template shadowrootmode=open shadowrootclonable>q</template></div><template shadowrootmode=open>x</template></template>
    HTML
    expect(s.evaluate_script(<<~JS)).to eq(['1', 1, 'closed', true, 0, true, 'TEMPLATE', 'x'])
      (() => {
        const d = document.getElementById('d'), content = document.getElementById('outer').content, c = content.getElementById('c');
        return [
          d.shadowRoot.textContent, d.children.length, d.firstElementChild.getAttribute('shadowrootmode'),
          !!c.shadowRoot, c.childNodes.length, !!document.importNode(c, true).shadowRoot,
          content.lastElementChild.tagName, content.lastElementChild.content.textContent
        ];
      })()
    JS
  end

  # A declarative template in another's shadow root, where the host takes none, goes into that shadow root — the
  # contents of the template around it (it went into that template's own unused contents, and was lost). A custom
  # element in a declarative shadow root is connected once; a sheet a root in template contents names is none it can
  # adopt (the parse threw); and a write into an opened document leaves a top-level template `<body>`'s shadow root,
  # its script run.
  it 'puts each node where the parser has it' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><script>window.log = []; customElements.define('x-b', class extends HTMLElement { connectedCallback() { log.push('conn:' + this.isConnected); } });</script>
      <div id=h><template shadowrootmode=open>A<template shadowrootmode=closed>X</template>B<x-b></x-b></template></div>
      <template id=t><div><template shadowrootmode=open shadowrootadoptedstylesheets="data:text/css,p{color:red}"><p>x</p></template></div></template>
      <iframe id=f></iframe>
    HTML
    expect(s.evaluate_script(<<~JS)).to eq(['A<template shadowrootmode="closed">X</template>B', ['conn:true'], true, true, 'Tparent.inran = 1', ['P'], 1])
      (() => {
        const h = document.getElementById('h'), d = document.getElementById('f').contentDocument;
        d.open(); d.write('<p>x</p><template shadowrootmode=open>T<script>parent.inran = 1</script></template>'); d.close();
        return [
          h.shadowRoot.innerHTML.replace('<x-b></x-b>', ''), log, !!document.getElementById('t').content.firstElementChild.shadowRoot,
          !!d.body.shadowRoot, d.body.shadowRoot && d.body.shadowRoot.textContent, Array.from(d.body.children, (c) => c.tagName), window.inran
        ];
      })()
    JS
  end

  # `setHTMLUnsafe` attaches them too — but not to its own element, the fragment's context, whose template stays one.
  it 'attaches the ones setHTMLUnsafe parses' do
    s = session_for('<!DOCTYPE html><body><div id=w></div>')
    expect(s.evaluate_script(<<~JS)).to eq([2, 1, true, 'TEMPLATE', false])
      (() => {
        const w = document.getElementById('w');
        w.setHTMLUnsafe('<p><template shadowrootmode=open>c</template>t</p><template shadowrootmode=open>top</template>');
        return [w.children.length, w.firstElementChild.childNodes.length, !!w.firstElementChild.shadowRoot, w.lastElementChild.tagName, !!w.shadowRoot];
      })()
    JS
  end

  # `Document.parseHTMLUnsafe` makes a document that allows them — one with no browsing context, as DOMParser's: nothing
  # constructed or run, `<noscript>` markup, about:blank its URL. (HTML makes it "a new Document"; Chrome an
  # HTMLDocument.)
  it 'attaches the ones Document.parseHTMLUnsafe parses' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><script>customElements.define('x-a', class extends HTMLElement { constructor() { super(); window.made = 1; } });</script>
    HTML
    expect(s.evaluate_script(<<~JS)).to eq(['about:blank', 'complete', 'text/html', nil, true, 0, 0, '<p>n</p>', true, 1])
      (() => {
        const d = Document.parseHTMLUnsafe('<div id=h><template shadowrootmode=open>S</template></div><x-a></x-a><script>window.ran=1<\/script><noscript><p>n</p></noscript>');
        return [d.URL, d.readyState, d.contentType, d.defaultView, !!d.getElementById('h').shadowRoot, window.made || 0, window.ran || 0,
                d.querySelector('noscript').innerHTML, d.customElementRegistry === null, Document.parseHTMLUnsafe.length];
      })()
    JS
  end
end
