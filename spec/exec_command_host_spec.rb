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
end
