# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# `document.write` from a script the parser is running writes at the INSERTION POINT (HTML §8.4.3): into the input
# stream right after that script's `</script>`, tokenized there before `write` returns. It used to parse the markup as
# a fragment and append it to `<body>`, which is the same place only for a script that is a direct child of `<body>` —
# anywhere else it reordered the page. Every expectation here is Chrome's.
RSpec.describe 'document.write during parsing' do
  def session_for(body)
    html = "<!DOCTYPE html><html><head></head><body>#{body}</body></html>"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  it 'writes at the insertion point of a script nested in an element' do
    s = session_for('<div id="w">one<script>document.write("<b>two</b> three")</script> four</div>' \
                    '<div id="v"><p>one</p><script>document.write("<p>two</p>"); document.write("<p>2.5</p>")</script><p>four</p></div>')
    expect(s.evaluate_script("['w', 'v'].map((id) => document.getElementById(id).innerText)")).to eq(['onetwo three four', "one\n\ntwo\n\n2.5\n\nfour"])
  end

  # …tokenized before `write` returns, so the script that wrote it can read it — a tag split across two writes too.
  it 'parses what it wrote before returning' do
    s = session_for('<div id="a">1<script>document.write("<b"); document.write(" id=\\"bb\\">2</b>"); ' \
                    'window.sync = document.getElementById("bb") && document.getElementById("bb").textContent</script>3</div>')
    expect(s.evaluate_script("[window.sync, [...document.getElementById('a').childNodes].map((n) => n.nodeName)]")).to eq(['2', %w[#text SCRIPT B #text]])
  end

  # An INLINE script in the written markup runs right there, inside `write` (the "text" insertion mode prepares and
  # runs it at once, nesting level or not): it sees nothing the writer writes after, and its own write lands first.
  # Chrome and Firefox: `A:false:null`, `after1:false`, `after2:true`, and "aYXc".
  it 'runs an inline written script inside write, before the writer goes on' do
    s = session_for('<div id="w">a<script>window.L = []; document.write("<script>L.push(\'A:\' + !!document.getElementById(\'x\') + \':\' + ' \
                    '(document.currentScript.nextSibling && document.currentScript.nextSibling.nodeName)); document.write(\'Y\')<\\/script>"); ' \
                    'L.push("after1:" + !!document.getElementById("x")); document.write("<i id=x>X</i>"); ' \
                    'L.push("after2:" + !!document.getElementById("x"));</script>c</div>')
    expect(s.evaluate_script("[L, document.getElementById('w').innerText]")).to eq([%w[A:false:null after1:false after2:true], 'aYXc'])
  end

  # A constructor the parser runs holds the throw-on-dynamic-markup-insertion counter; a template's script is inert and
  # never runs; `document.open()` from a parser-run script does nothing; and the deferred scripts run once the document
  # is 'interactive'. Chrome: all four.
  it 'keeps the other parser contracts around scripts' do
    s = session_for('<script>window.L = []; customElements.define("x-e", class extends HTMLElement { constructor() { super(); ' \
                    'try { document.write("<b>ce</b>"); L.push("ce:wrote"); } catch (e) { L.push("ce:" + e.name); } } });</script>' \
                    '<x-e></x-e><template><script>L.push("RAN")</script>in-tpl</template>' \
                    '<div id="o">1<script>document.open(); document.write("w");</script>2</div>' \
                    '<script type="module">L.push("module:" + document.readyState)</script>')
    expect(s.evaluate_script("[L, document.getElementById('o').innerText, !!document.querySelector('b')]")).to eq(
      [%w[ce:InvalidStateError module:interactive], '1w2', false]
    )
  end

  # …and an inline script in the written markup runs inside the write, writing at ITS own insertion point.
  it 'runs a written script at its own insertion point' do
    s = session_for(%(<div id="n">a<script>document.write("<script>document.write('[inner]')<\\/script>b")</script>c</div>))
    expect(s.evaluate_script("document.getElementById('n').innerText")).to eq('a[inner]bc')
  end

  it 'writes into a table row where the script stands' do
    s = session_for('<table id="t"><tr><td>c1</td><script>document.write("<td>c2</td>")</script><td>c3</td></tr></table>')
    expect(s.evaluate_script("[...document.querySelectorAll('#t td')].map((c) => c.textContent)")).to eq(%w[c1 c2 c3])
  end

  # An EXTERNAL parser-blocking script in the written markup is the pending parsing-blocking script: it runs once the
  # nesting level is back to zero, and until it has, what is written goes in after what was written before it. Chrome:
  # e1 runs before the text after it is parsed (`XYZ`, not `YXZ`), three written external scripts run in the order they
  # were written, and one written by a NESTED script waits for the outer script to return.
  def session_with_scripts(body)
    scripts = %w[a b c e1].to_h {|n| ["/#{n}.js", "L.push('#{n}:' + txt('o'));"] }
    html = <<~HTML
      <!DOCTYPE html><meta charset="utf-8"><script>
        window.L = [];
        // The text of an element, its scripts' left out.
        window.txt = (id) => { const e = document.getElementById(id); let s = ''; if (!e) return s;
          const w = (n) => { if (n.nodeType === 3) s += n.data; else if (n.localName !== 'script') n.childNodes.forEach(w); };
          w(e); return s.replace(/\\s+/g, ''); };
      </script>
      #{body}
    HTML
    app = ->(env) {
      js = scripts[env['PATH_INFO']]
      js ? [200, {'content-type' => 'text/javascript'}, [js]] : [200, {'content-type' => 'text/html'}, [html]]
    }
    simulated_session(app).tap {|s| s.visit '/' }
  end

  it 'parses what is written after a pending script where it was written' do
    s = session_with_scripts(<<~HTML)
      <div id=o><script>document.write('<script src=e1.js><\\/script>X'); document.write('Y');</script>Z</div>
      <script>L.push('after:' + txt('o'));</script>
      <script>document.write('<script src=a.js><\\/script>'); document.write('<script src=b.js><\\/script>'); document.write('<script src=c.js><\\/script>');</script>
    HTML
    expect(s.evaluate_script('L')).to eq(%w[e1: after:XYZ a:XYZ b:XYZ c:XYZ])
  end

  it 'runs a pending script a nested script wrote once the outer one has returned' do
    s = session_with_scripts(<<~HTML)
      <div id=o><script>function inner() { document.write('<script src=e1.js><\\/script>'); L.push('inner-after'); }
      document.write('<script>inner()<\\/script>Q'); L.push('outer-after:' + txt('o'));</script>Z</div>
    HTML
    expect(s.evaluate_script('L')).to eq(%w[inner-after outer-after: e1:])
    expect(s.evaluate_script("txt('o')")).to eq('QZ')
  end

  # …and one a DECLARATIVE SHADOW ROOT's script wrote runs before the parse goes on, as any other. Chrome: dsd, e1, next.
  it 'runs a pending script a declarative shadow root\'s script wrote' do
    s = session_with_scripts(<<~HTML)
      <div id=h><template shadowrootmode=open><script>document.write('<script src=e1.js><\\/script>'); L.push('dsd');</script></template></div>
      <p>tail</p><script>L.push('next');</script>
    HTML
    expect(s.evaluate_script('L')).to eq(%w[dsd e1: next])
  end

  # A doctype token in the "initial" insertion mode is APPENDED to the document (HTML §13.2.6.4.1), whatever the document
  # holds already: a doctype a script appended after `document.open()` stays first, the written one follows it, and the
  # written one sets the mode. Firefox: `a,html,HTML`, `a`, `CSS1Compat` (Chrome keeps one: `a,HTML`).
  it 'appends a written doctype after one the document already has' do
    s = session_for('<p>x</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const f = document.createElement('iframe');
        document.body.append(f);
        const d = f.contentDocument;
        d.open();
        d.appendChild(d.implementation.createDocumentType('a', '', ''));
        d.write('<!doctype html><p>x');
        d.close();
        return [[...d.childNodes].map((n) => n.nodeName), d.doctype.name, d.compatMode];
      })()
    JS
    expect(got).to eq([%w[a html HTML], 'a', 'CSS1Compat'])
  end

  # A script-created parser in a document with no browsing context (`createHTMLDocument`'s) builds what is written as
  # any parser does: an observer's records queued, a select's options set up as it closes, and the document's mode
  # set from the doctype written — none, quirks (Chrome: `1 3 x true BackCompat`; Firefox the same).
  it 'parses what is written into a document with no browsing context' do
    s = session_for('<p>x</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.implementation.createHTMLDocument('');
        const mo = new MutationObserver(() => {});
        mo.observe(d, {childList: true, subtree: true});
        d.open();
        d.write('<select id=s><option>a<option selected>b<option>c</select><p id=p>x</p>');
        d.close();
        const s = d.getElementById('s');
        return [s.selectedIndex, s.options.length, d.getElementById('p').textContent, mo.takeRecords().length > 0, d.compatMode];
      })()
    JS
    expect(got).to eq([1, 3, 'x', true, 'BackCompat'])
  end

  # …and an iframe srcdoc document — a Document whose URL matches `about:srcdoc` — opened by its parent's script is one no
  # more: "document open steps" give it the URL of the entry document, the parent's, so what is written with no doctype
  # makes it quirks (Firefox 159, measured 2026-11-01: `BackCompat` at the parent's URL; Chrome 156 changes the URL too
  # but keeps `CSS1Compat`).
  it 'gives an iframe srcdoc document opened by its parent the parent’s URL, and quirks' do
    s = session_for('<iframe id=f srcdoc="<!DOCTYPE html><p>a"></iframe>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const w = document.getElementById('f').contentWindow, d = w.document;
        d.open();
        d.write('<p>y');
        d.close();
        const inner = w.eval("document.open(); document.write('<p>z'); document.close(); document.compatMode");
        return [d.compatMode, d.URL, inner];
      })()
    JS
    expect(got).to eq(['BackCompat', 'http://www.example.com/', 'BackCompat'])
  end

  # A declarative shadow root's script that writes once the input has run out: no insertion point is left to write at,
  # and nothing the parser does on the write may bring the process down (it did: a panic, aborting).
  it 'survives a write from a declarative shadow root left open at the end of the input' do
    s = session_with_scripts(%(<div id=h><template shadowrootmode=open><script>document.write('<b>x</b>')</script>))
    expect(s.evaluate_script('document.getElementById("h") !== null')).to be true
  end

  # What the steps of dynamic markup insertion do first is the engine's (document_lifecycle.rs `markup_steps`), of the
  # document's active parser: an `open()` from a script the script-created parser runs returns (its script nesting level
  # above zero), and that script's `write` goes in at its insertion point; a `write` once that parser's input has ended
  # has no insertion point and opens the document anew; a `close()` with no script-created parser does nothing. Chrome
  # and Firefox agree on each (measured 2026-11-07: `ba`, `y`, `k`).
  it 'asks the document’s active parser where markup goes' do
    s = session_for('<p>x</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const run = (src) => {
          const f = document.body.appendChild(document.createElement('iframe'));
          try { return new f.contentWindow.Function(src)(); } finally { f.remove(); }
        };
        return [
          run('document.open(); document.write("<script>document.open(); document.write(\\\\"b\\\\")<\\\\/script>a"); document.close(); return document.body.textContent;'),
          run('document.open(); document.write("<p>x"); document.close(); document.write("y"); document.close(); return document.body.textContent;'),
          run('document.body.append("k"); document.close(); return document.body.textContent;')
        ];
      })()
    JS
    expect(got).to eq(%w[ba y k])
  end

  # An `open()` from no script the page's parser runs — a frame's `load` fired as the parser inserts it — opens the
  # document, and the page's parse builds nothing more into the document written: "stop loading" aborts it, and it is
  # no longer the document's active parser (html_parse.rs `begin_script_created`). Chrome and Firefox `new` (measured
  # 2026-11-07 — Firefox fires the frame's load after the parse).
  it 'aborts the page’s parse that an open() from a frame’s load replaces' do
    s = session_for(%(<iframe onload="if (!window.done) { window.done = 1; document.open(); ) +
                    %(document.write('<!DOCTYPE html><p>new</p>'); document.close(); }"></iframe><p>old-after</p>))
    expect(s.evaluate_script('document.body.textContent.trim()')).to eq('new')
  end
end
