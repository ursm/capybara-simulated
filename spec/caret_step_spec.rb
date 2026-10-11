# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A caret's step by one character — ArrowLeft / ArrowRight in an editing host, `Selection.modify` by a character —
# the engine's (caret.rs `caret_step`). Every expectation is Chrome's.
RSpec.describe 'stepping a caret by a character' do
  def session_for(html)
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  # The selection's focus, as `text@offset` (or `NODENAME@offset`).
  def focus_js
    "const desc = () => { const s = getSelection(), n = s.focusNode; return (n.nodeType === 3 ? n.data : n.nodeName) + '@' + s.focusOffset; };"
  end

  # Across an inline edge the step takes the next character too — the places either side of the edge are one place on
  # the line, and an empty leaf none at all; it stops at an editing host's edge.
  it 'takes the next character across an inline edge' do
    s = session_for('<!DOCTYPE html><body><p id=p>ab<b>cd</b> ef</p><div contenteditable id=e>gh<i>ij</i></div>')
    expect(s.evaluate_script(<<~JS)).to eq(['cd@1', 'cd@1', 'ij@2', 'gh@0', 'ab@1', 0])
      (() => {
        #{focus_js}
        const s = getSelection(), out = [], p = document.getElementById('p'), e = document.getElementById('e');
        s.collapse(p.firstChild, 2); s.modify('move', 'forward', 'character'); out.push(desc());
        s.collapse(p.lastChild, 0); s.modify('move', 'backward', 'character'); out.push(desc());
        s.collapse(e.lastChild.firstChild, 2); s.modify('move', 'forward', 'character'); out.push(desc());
        s.collapse(e.firstChild, 0); s.modify('move', 'backward', 'character'); out.push(desc());
        s.collapse(p.firstChild, 0); s.modify('extend', 'forward', 'character'); out.push(desc(), s.anchorOffset);
        return out;
      })()
    JS
  end

  # Across a line's end — a block's edge, a `<br>` — it stops at the edge of what comes next; an image is a stop of its
  # own, which it passes.
  it 'stops at the edge across a line end, and passes an image' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><div contenteditable id=e><p id=a>ab</p><p id=b>cd<br>ef<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width=5 height=5>gh<span></span>ij</p></div>
    HTML
    e = s.find(:css, '#e')
    out = []
    place = ->(js) { s.execute_script("(() => { getSelection().collapse(#{js}); })()") }
    read = -> { s.evaluate_script("(() => { #{focus_js} return desc(); })()") }
    e.click
    place.("document.getElementById('a').firstChild, 2")
    e.send_keys(:right)
    out << read.()
    place.("document.getElementById('b').firstChild, 0")
    e.send_keys(:left)
    out << read.()
    place.("document.getElementById('b').firstChild, 2")
    e.send_keys(:right)
    out << read.()
    place.("document.getElementById('b').childNodes[2], 2")
    e.send_keys(:right)
    out << read.()
    e.send_keys(:right)
    out << read.()
    place.("document.getElementById('b').childNodes[4], 2")
    e.send_keys(:right)
    out << read.()
    place.("document.getElementById('b').childNodes[2], 0")
    e.send_keys(:left)
    out << read.()
    expect(out).to eq(['cd@0', 'ab@2', 'ef@0', 'P@4', 'gh@1', 'ij@1', 'cd@2'])
  end
end
