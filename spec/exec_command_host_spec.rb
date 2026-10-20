require 'capybara/simulated'
require_relative 'support/session_teardown'

# document.execCommand acts in the editing host the selection is in — as queryCommandEnabled answers it — whatever has
# focus: a contenteditable's text selected with nothing focused, and a design-mode document's. Chrome 155 on this page:
# `[true, "<b>world</b>", true, true, "<b>hello</b>"]`, the body the active element.
RSpec.describe 'execCommand in the selection’s editing host' do
  it 'formats where the selection is, focused or not' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p id=p>hello</p><div contenteditable><p id=q>world</p></div>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const out = [];
        const q = document.getElementById('q').firstChild;
        getSelection().setBaseAndExtent(q, 0, q, 5);
        out.push(document.execCommand('bold'), document.getElementById('q').innerHTML);
        document.designMode = 'on';
        const p = document.getElementById('p').firstChild;
        getSelection().setBaseAndExtent(p, 0, p, 5);
        out.push(document.queryCommandEnabled('bold'), document.execCommand('bold'), document.getElementById('p').innerHTML);
        return out;
      })()
    JS
    expect(got).to eq([true, '<b>world</b>', true, true, '<b>hello</b>'])
  end

  # The root editable element (Chrome's and Firefox's): a `contenteditable=true` nested in an editable element edits in
  # place, `input` at the outer root; one in a `contenteditable=false` island is a root of its own (a `plaintext-only`
  # outer one deciding nothing for it); a focused text control is the target, not a contenteditable the selection was
  # left in; a document with no browsing context edits nothing; in design mode `input` goes to the body. Chrome 155:
  # `<b>inner</b>` input at #a, island bold input at #bi, the plaintext-only outer's island bold input at #ci, bold with
  # a textarea focused false and nothing changed, a createHTMLDocument's false, design mode's input at BODY.
  it 'acts in the root editable element, a focused text control, or nothing' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8"><body>
        <div id=a contenteditable><p>x<span id=ai contenteditable=true>inner</span>y</p></div>
        <div id=b contenteditable><span contenteditable=false><b id=bi contenteditable=true>island</b></span></div>
        <div id=c contenteditable=plaintext-only><span contenteditable=false><i id=ci contenteditable=true>pio</i></span></div>
        <div id=e contenteditable>eeee</div><textarea id=t>tt</textarea><p id=p>plain</p>
      HTML
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const seen = [];
        document.addEventListener('input', (ev) => seen.push(ev.target.id || ev.target.nodeName));
        const bold = (id) => {
          const t = document.getElementById(id).firstChild;
          getSelection().setBaseAndExtent(t, 0, t, t.length);
          return [document.execCommand('bold'), document.getElementById(id).innerHTML];
        };
        const out = [bold('ai'), bold('bi'), bold('ci')];
        const e = document.getElementById('e').firstChild;
        getSelection().setBaseAndExtent(e, 0, e, 2);
        document.getElementById('t').focus();
        out.push([document.execCommand('bold'), document.getElementById('e').innerHTML]);
        document.getElementById('t').blur();
        out.push(document.implementation.createHTMLDocument('').execCommand('italic'));
        document.designMode = 'on';
        const p = document.getElementById('p').firstChild;
        getSelection().setBaseAndExtent(p, 0, p, 5);
        out.push(document.execCommand('bold'));
        return [out, seen];
      })()
    JS
    expect(got).to eq([
      [[true, '<b>inner</b>'], [true, '<b>island</b>'], [true, '<b>pio</b>'], [false, 'eeee'], false, true],
      ['a', 'bi', 'ci', 'BODY']
    ])
  end

  # The selection's ANCHOR decides the root, as the engine's edits go by it: a backward selection from one host into
  # another bolds in the anchor's, `input` there (Chrome 155: true, `<b>k2</b>text`, input at k2). A readonly text
  # control is no target: insertText into a focused `<textarea readonly>` is false and changes nothing (Chrome 155).
  it "takes the anchor's root, and refuses a readonly text control" do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><div id=k1 contenteditable>k1text</div><div id=k2 contenteditable>k2text</div><textarea id=ro readonly>ro</textarea>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const seen = [];
        document.addEventListener('input', (ev) => seen.push(ev.target.id));
        const k1 = document.getElementById('k1').firstChild, k2 = document.getElementById('k2').firstChild;
        getSelection().setBaseAndExtent(k2, 2, k1, 2);
        const bold = [document.execCommand('bold'), document.getElementById('k2').innerHTML];
        const ro = document.getElementById('ro');
        ro.focus();
        const readonly = [document.execCommand('insertText', false, 'Q'), ro.value];
        return [bold, readonly, seen];
      })()
    JS
    expect(got).to eq([[true, '<b>k2</b>text'], [false, 'ro'], ['k2']])
  end

  # Backspace's and Delete's deletion and a line break in a focused text control, as the keys make them. Chrome 155:
  # `acd`, `ad`, `a\nd`, `a\n\nd` in the textarea, an input unchanged by a paragraph and `wyz` by a deletion — true
  # each time, `input` for each change.
  it 'deletes and breaks lines in a focused text control' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><textarea id=t>abcd</textarea><input id=i value=wxyz>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const t = document.getElementById('t'), i = document.getElementById('i'), seen = [];
        document.addEventListener('input', (e) => seen.push(e.target.id + ':' + e.inputType));
        t.focus();
        t.setSelectionRange(2, 2);
        const out = [document.execCommand('delete'), t.value, document.execCommand('forwardDelete'), t.value,
                     document.execCommand('insertParagraph'), t.value, document.execCommand('insertLineBreak'), t.value];
        i.focus();
        i.setSelectionRange(2, 2);
        out.push(document.execCommand('insertParagraph'), i.value, document.execCommand('delete'), i.value);
        return [out, seen];
      })()
    JS
    expect(got).to eq([
      [true, 'acd', true, 'ad', true, "a\nd", true, "a\n\nd", true, 'wxyz', true, 'wyz'],
      ['t:deleteContentBackward', 't:deleteContentForward', 't:insertParagraph', 't:insertLineBreak', 'i:deleteContentBackward']
    ])
  end

  # A scripted edit goes where the selection a script reads is — the start where none was set, Chrome's caret after
  # focus() — and is a user edit: `change` on blur. insertText fires `input` where the value changed alone (a full
  # `maxlength`: none), and with empty text deletes a contenteditable's selection. Chrome 155: `wxyz` unchanged by a
  # delete at 0, `xyz` by a forward delete, a change on blur, no input for the full field, `hlo` with an insertText
  # input of "".
  it 'edits at the selection a script reads, as a user edit' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><input id=i value=wxyz><input id=m maxlength=3 value=abc><div id=d contenteditable>hello</div>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const seen = [];
        document.addEventListener('input', (e) => seen.push(e.target.id + ':' + e.inputType + ':' + JSON.stringify(e.data)));
        document.addEventListener('change', (e) => seen.push(e.target.id + ':change'));
        const i = document.getElementById('i'), m = document.getElementById('m');
        i.focus();
        const out = [document.execCommand('delete'), i.value, document.execCommand('forwardDelete'), i.value];
        m.focus();
        out.push(document.execCommand('insertText', false, 'Z'), m.value);
        m.blur();
        const t = document.getElementById('d').firstChild;
        getSelection().setBaseAndExtent(t, 1, t, 3);
        out.push(document.execCommand('insertText', false, ''), document.getElementById('d').textContent);
        return [out, seen];
      })()
    JS
    expect(got).to eq([
      [true, 'wxyz', true, 'xyz', true, 'abc', true, 'hlo'],
      ['i:deleteContentForward:null', 'i:change', 'd:insertText:""']
    ])
  end

  # A selection replaced by the same text is an edit all the same (Chrome 155: `input`, data "b", the value `abc`); a
  # cut with nothing selected cuts nothing (false, no input — Blink's cut needs a range selected; headless Chrome
  # refuses a scripted cut outright, so this is its rule, not a measurement); insertHTML into an input is an
  # insertText's `input`.
  it 'fires input for a replaced selection, none for an empty cut' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><input id=i value=abc>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const i = document.getElementById('i'), seen = [];
        document.addEventListener('input', (e) => seen.push(e.inputType + ':' + JSON.stringify(e.data)));
        i.focus();
        i.setSelectionRange(1, 2);
        const out = [document.execCommand('insertText', false, 'b'), i.value];
        i.setSelectionRange(1, 1);
        out.push(document.queryCommandEnabled('cut'), document.execCommand('cut'), i.value, document.execCommand('insertHTML', false, '<b>Q</b>'), i.value);
        return [out, seen];
      })()
    JS
    expect(got).to eq([[true, 'abc', false, false, 'abc', true, 'aQbc'], ['insertText:"b"', 'insertText:"Q"']])
  end

  # A design-mode document's editing root is its body (element_state.rs `design_mode_body`), for the edit as for what
  # queryCommandEnabled answers: a block command wraps the body's content, as a contenteditable host's — not the document
  # element's, which took the head into the block and left the document with no body.
  it 'wraps a design-mode document’s body content, not its head' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>x']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.designMode = 'on';
        const out = [];
        for (const command of ['justifyCenter', 'indent', 'insertOrderedList']) {
          document.body.innerHTML = 'abcd';
          getSelection().collapse(document.body.firstChild, 1);
          document.execCommand(command);
          out.push(document.head !== null && document.body !== null && document.body.firstElementChild?.localName);
        }
        return out;
      })()
    JS
    expect(got).to eq(%w[div blockquote ol])
  end

  # …and wherever in the document its selection is — a caret in the `<title>`, a range over the document element, which
  # Ctrl+A in a design-mode document made — an edit goes into the body, at the edge on the selection's side, and the head
  # is never edited (Chrome: `insertText` at a title caret types at the body's start; `selectAll` selects the body's
  # content).
  it 'edits a design-mode document’s body wherever its selection is' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><title>TT</title><body><p>abcd</p>']] })
    s.visit '/'
    s.execute_script(<<~JS)
      document.designMode = 'on';
      getSelection().collapse(document.querySelector('title').firstChild, 1);
      document.execCommand('insertText', false, 'Z');
    JS
    s.find('body').send_keys([:control, 'a'])
    got = s.evaluate_script(<<~JS)
      (() => {
        const sel = getSelection(), range = [sel.anchorNode.localName, sel.anchorOffset, sel.focusNode.localName, sel.focusOffset];
        const typed = document.body.innerHTML;
        document.execCommand('indent');
        return [document.title, typed, range, document.head.innerHTML, document.body.firstElementChild.localName];
      })()
    JS
    expect(got).to eq(['TT', 'Z<p>abcd</p>', ['body', 0, 'body', 2], '<meta charset="utf-8"><title>TT</title>', 'blockquote'])
  end

  # …but an element a script put beside the body, under the document element, is edited where it is (Chrome: `afZter`).
  it 'edits an element beside a design-mode document’s body in place' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body><p>abcd</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.designMode = 'on';
        const after = document.documentElement.appendChild(document.createElement('div'));
        after.textContent = 'after';
        getSelection().collapse(after.firstChild, 2);
        document.execCommand('insertText', false, 'Z');
        return [after.textContent, document.body.innerHTML];
      })()
    JS
    expect(got).to eq(['afZter', '<p>abcd</p>'])
  end

  # A copy in a document with no browsing context — a created one, a removed frame's — has no selection a window holds:
  # false, as every other command there (it threw a TypeError).
  it 'answers false for a copy in a document with no browsing context' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe></iframe>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const created = document.implementation.createHTMLDocument('');
        const frame = document.querySelector('iframe'), removed = frame.contentDocument;
        frame.remove();
        return [created.execCommand('copy'), removed.execCommand('copy')];
      })()
    JS
    expect(got).to eq([false, false])
  end
end
