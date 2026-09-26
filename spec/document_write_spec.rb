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
end
