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

  # An empty line — a `<br>` ending a line with nothing on it — is a stop, before that `<br>`; one ending a line with text
  # on it is passed.
  it 'stops on an empty line' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><div contenteditable><p>ab</p><p id=em><br></p><p>cd</p></div><div contenteditable id=e2>ab<br><br>cd</div>
      <div contenteditable><p id=t>ab<br></p><p>cd</p><p id=lead><br>gh</p></div>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const desc = () => { const s = getSelection(), n = s.focusNode; return (n.nodeType === 3 ? n.data : n.nodeName + '#' + n.id) + '@' + s.focusOffset; };
        const s = getSelection(), em = document.getElementById('em'), e2 = document.getElementById('e2');
        const step = (node, off, dir) => { s.collapse(node, off); s.modify('move', dir, 'character'); return desc(); };
        return [
          step(em.previousSibling.firstChild, 2, 'forward'), step(em.nextSibling.firstChild, 0, 'backward'),
          step(e2.firstChild, 2, 'forward'), step(e2.lastChild, 0, 'backward'),
          step(document.getElementById('t').nextSibling.firstChild, 0, 'backward'), step(document.getElementById('t').firstChild, 2, 'forward'),
          step(document.getElementById('lead').lastChild, 0, 'backward'), step(document.getElementById('lead').previousSibling.firstChild, 2, 'forward')
        ];
      })()
    JS
    expect(got).to eq(['P#em@0', 'P#em@0', 'DIV#e2@2', 'DIV#e2@2', 'ab@2', 'cd@0', 'P#lead@0', 'P#lead@0'])
  end

  # A word holds an apostrophe between letters and a full stop between digits, not one between letters, a colon or a
  # hyphen; and a script written without spaces breaks where its dictionary does.
  it "breaks words where Chrome's rules do" do
    s = session_for('<!DOCTYPE html><meta charset=utf-8><body><p id=p></p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const s = getSelection(), p = document.getElementById('p');
        return ["don't 3.14 x_y", 'a.b c', 'e.g. x', 'a:b', 'ab-cd', 'foo.bar', 'gh_i.jk', '日本語のテキスト東京都庁', '食べる人です', '私は東京大学の学生です。'].map((c) => {
          p.textContent = c;
          const t = p.firstChild, stops = [];
          s.collapse(t, 0);
          for (let i = 0; i < 8; i++) {
            s.modify('move', 'forward', 'word');
            if (s.focusNode !== t || stops.includes(s.focusOffset)) break;
            stops.push(s.focusOffset);
          }
          return stops.join(',');
        });
      })()
    JS
    expect(got).to eq(['5,10,14', '1,2,3,5', '1,2,3,4,6', '1,2,3', '2,3,5', '3,4,7', '4,5,7', '3,4,8,10,12', '3,4,6', '1,2,4,6,7,9,11,12'])
  end

  # From outside an editing host, a step goes over one, not into it: by a character to the stop past it, by a word
  # nowhere.
  it 'goes over an editing host from outside one' do
    s = session_for('<!DOCTYPE html><body><p id=s>st uv</p><div contenteditable>xx yy</div><p id=t>ab cd</p>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const desc = () => { const s = getSelection(), n = s.focusNode; return n.data + '@' + s.focusOffset; };
        const s = getSelection(), st = document.getElementById('s').firstChild, ab = document.getElementById('t').firstChild;
        const step = (node, off, dir, by) => { s.collapse(node, off); s.modify('move', dir, by); return desc(); };
        return [step(ab, 0, 'backward', 'character'), step(ab, 0, 'backward', 'word'), step(st, 5, 'forward', 'character'), step(st, 5, 'forward', 'word')];
      })()
    JS
    expect(got).to eq(['st uv@5', 'ab cd@0', 'ab cd@0', 'st uv@5'])
  end

  # Focusing an editing host with no selection in it puts the caret at its first caret position (caret.rs
  # `caret_edge`): its first rendered character, white space a line starts with collapsed away; before its first
  # `<br>` or image; its own start where it has none. A selection in it already stays.
  it 'puts the caret at the first caret position of an editing host it focuses' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body><div id=a contenteditable><p>abc</p><p>def</p></div><div id=b contenteditable><p><br></p></div>
      <div id=c contenteditable>  <b>x</b>yz</div><div id=d contenteditable><img src="data:,"><span>q</span></div>
      <div id=e contenteditable></div><div id=g contenteditable><p>abc</p><p>def</p></div>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        #{focus_js}
        const out = [];
        for (const id of ['a', 'b', 'c', 'd', 'e']) {
          getSelection().removeAllRanges();
          document.getElementById(id).focus();
          out.push(desc());
        }
        document.activeElement.blur();
        getSelection().collapse(document.querySelector('#g p + p').firstChild, 2);
        document.getElementById('g').focus();
        out.push(desc());
        return out;
      })()
    JS
    expect(got).to eq(['abc@0', 'P@0', 'x@0', 'DIV@0', 'DIV@0', 'def@2'])
  end

  # A click into an editor then typing types where it was clicked — here right of its text, on its line's blank: at
  # the end of the host's text, and of a paragraph's in it (Chrome).
  it 'types where a click into an editing host put the caret' do
    s = session_for('<!DOCTYPE html><body style="margin:0"><div id=e contenteditable style="width:400px;height:40px">Hello</div><div id=f contenteditable style="width:400px"><p>World</p></div>')
    e = s.find(:css, '#e')
    e.click
    e.send_keys('X')
    e.click
    e.send_keys('Y')
    f = s.find(:css, '#f')
    f.click
    f.send_keys('Z')
    expect(s.evaluate_script('[e.innerHTML, f.innerHTML]')).to eq(['HelloXY', '<p>WorldZ</p>'])
  end

  # …and in its text, between the characters nearest the point (caret_from_point): Chrome, clicking 2, 20, 33 and 60px
  # into `Hello World` and typing.
  it 'types where in its text a click into an editing host was' do
    typed = [2, 20, 33, 60].map {|x|
      s = session_for('<!DOCTYPE html><body style="margin:0"><div id=e contenteditable style="width:400px;height:40px;font:16px sans-serif">Hello World</div>')
      e = s.find(:css, '#e')
      e.click(x: x - 200, y: -10)
      e.send_keys('X')
      s.evaluate_script('e.textContent')
    }
    expect(typed).to eq(['XHello World', 'HeXllo World', 'HelloX World', 'Hello WXorld'])
  end

  # ArrowUp / ArrowDown move the caret a line, in a textarea's value and in an editing host, at the x the moves set out
  # from (a goal kept across them), to the start past the first line and the end past the last — Chrome's, every one.
  it 'moves the caret a line up and down' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body style="margin:0"><textarea id=t style="font:16px monospace;width:300px;height:100px">abcd
      ef
      ghij</textarea><div id=e contenteditable style="font:16px monospace;width:300px"><p>abcd</p><p>ef</p><p>ghij</p></div>
    HTML
    t = s.find(:css, '#t')
    t.click
    at = ->(keys) {
      t.send_keys(*keys)
      s.evaluate_script('[t.selectionStart, t.selectionEnd, t.selectionDirection]')
    }
    s.execute_script('t.setSelectionRange(6, 6)')
    expect([at.([:up]), at.([:up])]).to eq([[1, 1, 'none'], [0, 0, 'none']])
    s.execute_script('t.setSelectionRange(3, 3)')
    expect([at.([:down]), at.([:down]), at.([:down]), at.([[:shift, :up]])]).to eq([[7, 7, 'none'], [11, 11, 'none'], [12, 12, 'none'], [7, 12, 'backward']])
    e = s.find(:css, '#e')
    e.click
    desc = ->(keys) {
      e.send_keys(*keys)
      s.evaluate_script('(() => { const s = getSelection(); return (s.focusNode.data ?? s.focusNode.nodeName) + "@" + s.focusOffset; })()')
    }
    s.execute_script('getSelection().collapse(document.querySelector("#e p").firstChild, 3)')
    expect([desc.([:down]), desc.([:down]), desc.([:down])]).to eq(['ef@2', 'ghij@3', 'ghij@4'])
    s.execute_script('getSelection().collapse(document.querySelector("#e p").firstChild, 2)')
    expect(desc.([:up])).to eq('abcd@0')
  end

  # …over an empty line — to the place before the `<br>` ending it, or after the newline opening it — and through
  # indentation a line holds (Chrome); and a click beside an editing host's text in a flex row types after it, not in
  # the column beside (Chrome: `HelloX`).
  it 'moves the caret onto empty lines and through indentation' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body style="margin:0;font:16px monospace"><textarea id=t style="font:16px monospace">abc

      xyz</textarea><textarea id=u style="font:16px monospace">    abc
          def</textarea>
      <div id=e contenteditable><p>abc</p><p><br></p><p>xyz</p></div>
      <div id=f contenteditable>line one<br>line two<br><br>line four</div>
      <div style="display:flex"><div id=ed contenteditable style="width:400px;min-height:200px"><p style="margin:0">Hello</p></div><aside style="width:200px">Sidebar link</aside></div>
    HTML
    down = ->(id, js) {
      el = s.find(:css, "##{id}")
      el.click
      s.execute_script(js)
      el.send_keys(:down)
      s.evaluate_script(%[(() => { const el = document.getElementById("#{id}"); if (el.localName === "textarea") return el.selectionStart; const s = getSelection(); return (s.focusNode.data ?? s.focusNode.nodeName) + "@" + s.focusOffset; })()])
    }
    expect(down.('t', 't.setSelectionRange(2, 2)')).to eq(4)
    expect([down.('u', 'u.setSelectionRange(2, 2)'), down.('u', 'u.setSelectionRange(0, 0)')]).to eq([10, 8])
    expect(down.('e', 'getSelection().collapse(document.querySelector("#e p").firstChild, 2)')).to eq('P@0')
    expect(down.('f', 'getSelection().collapse(document.getElementById("f").childNodes[2], 3)')).to eq('DIV@4')
    f = s.find(:css, '#f')
    f.send_keys(:down)
    expect(s.evaluate_script('(() => { const s = getSelection(); return s.focusNode.data + "@" + s.focusOffset; })()')).to eq('line four@3')
    ed = s.find(:css, '#ed')
    ed.click
    ed.send_keys('X')
    expect(s.evaluate_script('document.getElementById("ed").textContent')).to eq('HelloX')
  end

  # …onto a line the editor's scroller clipped away — the caret goes there and the editor scrolls to show it, a textarea
  # and an editing host that scrolls alike (Chrome: 14 at 21, then 20 at 41; `cccc@2` at 21).
  it 'moves the caret onto a line a scroller clipped, and scrolls to it' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body style="margin:0;font:16px monospace"><textarea id=t style="font:16px monospace;width:300px;height:40px;line-height:20px;padding:0;border:0;display:block">line1
      line2
      line3
      line4
      line5</textarea>
      <div id=e contenteditable style="width:300px;height:40px;overflow:auto;line-height:20px"><p style="margin:0">aaaa</p><p style="margin:0">bbbb</p><p style="margin:0">cccc</p><p style="margin:0">dddd</p></div>
    HTML
    t = s.find(:css, '#t')
    t.click
    s.execute_script('t.setSelectionRange(8, 8)')
    t.send_keys(:down)
    first = s.evaluate_script('[t.selectionStart, t.scrollTop]')
    t.send_keys(:down)
    expect([first, s.evaluate_script('[t.selectionStart, t.scrollTop]')]).to eq([[14, 21], [20, 41]])
    e = s.find(:css, '#e')
    e.click
    s.execute_script('getSelection().collapse(document.querySelectorAll("#e p")[1].firstChild, 2)')
    e.send_keys(:down)
    expect(s.evaluate_script('(() => { const s = getSelection(); return [s.focusNode.data + "@" + s.focusOffset, document.getElementById("e").scrollTop]; })()')).to eq(['cccc@2', 21])
  end

  # Home / End go to the edges of the caret's LINE as it wraps — End on a wrapped line past the space it hangs, where the
  # next line starts — in an editing host and in a textarea alike (Chrome: 10, 20, 10, 20; a textarea's last line 25).
  it 'moves the caret to the edges of its wrapped line' do
    s = session_for(<<~HTML)
      <!DOCTYPE html><body style="margin:0;font:16px monospace"><div id=e contenteditable style="width:120px">aaaa bbbb cccc dddd eeee</div><textarea id=t style="font:16px monospace;width:120px;height:100px">aaaa bbbb cccc dddd eeee
      second</textarea>
    HTML
    e = s.find(:css, '#e')
    e.click
    at = ->(offset, key) {
      s.execute_script("getSelection().collapse(document.getElementById('e').firstChild, #{offset})")
      e.send_keys(key)
      s.evaluate_script('getSelection().focusOffset')
    }
    expect([at.(12, :home), at.(12, :end), at.(2, :end), at.(22, :home)]).to eq([10, 20, 10, 20])
    t = s.find(:css, '#t')
    t.click
    ta = ->(offset, key) {
      s.execute_script("t.setSelectionRange(#{offset}, #{offset})")
      t.send_keys(key)
      s.evaluate_script('t.selectionStart')
    }
    expect([ta.(12, :home), ta.(12, :end), ta.(2, :end), ta.(27, :home)]).to eq([10, 20, 10, 25])
  end
end
