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

  # …and a script in the written markup runs after the one that wrote it, writing at ITS own insertion point.
  it 'runs a written script after the writer, at its own insertion point' do
    s = session_for(%(<div id="n">a<script>document.write("<script>document.write('[inner]')<\\/script>b")</script>c</div>))
    expect(s.evaluate_script("document.getElementById('n').innerText")).to eq('a[inner]bc')
  end

  it 'writes into a table row where the script stands' do
    s = session_for('<table id="t"><tr><td>c1</td><script>document.write("<td>c2</td>")</script><td>c3</td></tr></table>')
    expect(s.evaluate_script("[...document.querySelectorAll('#t td')].map((c) => c.textContent)")).to eq(%w[c1 c2 c3])
  end
end
