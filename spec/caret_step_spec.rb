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

  # By a word: past the white space, to the end (start, back) of the word there — word characters, across inline edges
  # — or of the punctuation; across a paragraph's end before any, to the next one's start (the last one's end, back).
  it 'moves by a word as Chrome does' do
    s = session_for('<!DOCTYPE html><body><p id=p>ab<b>cd</b> ef, gh_i.j  kl</p><p id=q>mn op</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        #{focus_js}
        const s = getSelection(), p = document.getElementById('p'), q = document.getElementById('q'), t = p.lastChild;
        const run = (node, off, dir) => { s.collapse(node, off); s.modify('move', dir, 'word'); return desc(); };
        return [
          run(p.firstChild, 0, 'forward'), run(p.firstChild, 1, 'forward'), run(t, 0, 'forward'), run(t, 3, 'forward'), run(t, 4, 'forward'),
          run(t, 6, 'forward'), run(t, 10, 'forward'), run(t, 15, 'forward'), run(q.firstChild, 2, 'forward'),
          run(t, 3, 'backward'), run(t, 1, 'backward'), run(t, 0, 'backward'), run(p.firstChild, 1, 'backward'), run(q.firstChild, 0, 'backward'),
          run(t, 13, 'backward')
        ];
      })()
    JS
    expect(got).to eq([
      'cd@2', 'cd@2', ' ef, gh_i.j  kl@3', ' ef, gh_i.j  kl@4', ' ef, gh_i.j  kl@9', ' ef, gh_i.j  kl@9', ' ef, gh_i.j  kl@11',
      'mn op@0', 'mn op@5', ' ef, gh_i.j  kl@1', 'ab@0', 'ab@0', 'ab@0', ' ef, gh_i.j  kl@15', ' ef, gh_i.j  kl@10'
    ])
  end

  # Only what renders is stepped over: not the white space between blocks or collapsed in a line, not a `<script>` or
  # a `display: none` subtree's text — and a surrogate pair is one character.
  it 'steps over what renders' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><meta charset=utf-8><body><div contenteditable id=e>
        <p id=a>ab</p>
        <p id=b>cd</p>
      </div>
      <p id=c>xy</p><script>/*s*/</script><div style="display:none">hid</div><p id=d>zw</p>
      <p id=f>a\u{1F600}b</p>
      <p id=g>pq <span>  rs</span></p>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const desc = () => { const s = getSelection(), n = s.focusNode; return (n.nodeType === 3 ? JSON.stringify(n.data) : n.nodeName) + '@' + s.focusOffset; };
        const s = getSelection(), at = (id) => document.getElementById(id).firstChild;
        const step = (node, off, dir) => { s.collapse(node, off); s.modify('move', dir, 'character'); return desc(); };
        return [
          step(at('a'), 2, 'forward'), step(at('b'), 0, 'backward'), step(at('c'), 2, 'forward'), step(at('d'), 0, 'backward'),
          step(at('f'), 1, 'forward'), step(at('g'), 2, 'forward'), step(at('g'), 3, 'forward')
        ];
      })()
    JS
    expect(got).to eq(['"cd"@0', '"ab"@2', '"zw"@0', '"xy"@2', "\"a\u{1F600}b\"@3", '"pq "@3', '"  rs"@3'])
  end
end
