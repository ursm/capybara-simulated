# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The Selection API, generated from its IDL: a document's selection, made by the platform alone — one per document with
# a browsing context, none for a DOMParser's — its state in slots, its arguments converted. A change to it, a script's
# change to its range included, schedules one selectionchange at the document, a task later; a text control's own
# selection schedules one at the control, which bubbles.
RSpec.describe 'Selection bindings' do
  let(:app) {
    lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><p id="p">Hello <b>world</b></p><input id="i" value="abcdef">']]
    }
  }

  def run(session, script)
    session.execute_script(<<~JS)
      globalThis.__out = null;
      (async () => { #{script} })().then((v) => { globalThis.__out = v; }, (e) => { globalThis.__out = 'threw ' + e.name + ': ' + e.message; });
    JS
    session.evaluate_script('globalThis.__out')
  end

  it 'is what its IDL says' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const sel = getSelection(), text = p.firstChild;
      const parsed = new DOMParser().parseFromString('<p>x</p>', 'text/html');
      const out = [
        err(() => new Selection()), sel === document.getSelection(), parsed.getSelection(),
        Object.getOwnPropertyDescriptor(globalThis, 'Selection').enumerable,
        err(() => sel.getRangeAt(0)), err(() => sel.collapseToStart()), err(() => sel.extend(text, 0)),
        err(() => sel.collapse(document.doctype, 0)), err(() => sel.collapse(text, 99)), err(() => sel.addRange(null))
      ];
      sel.setBaseAndExtent(text, 4, text, 1);
      out.push(sel.anchorOffset, sel.focusOffset, sel.direction, sel.type, String(sel), sel.getRangeAt(0) === sel.getRangeAt(0));
      const range = sel.getRangeAt(0);
      out.push(err(() => sel.removeRange(document.createRange())));
      sel.removeRange(range);
      out.push(sel.rangeCount, sel.direction);
      const detached = document.createRange();
      detached.selectNodeContents(document.createElement('div'));
      sel.addRange(detached);
      out.push(sel.rangeCount);
      sel.selectAllChildren(p);
      out.push(sel.containsNode(p.lastChild), sel.containsNode(p.lastChild.firstChild, true), sel.containsNode(i));
      return out;
    JS
    expect(out).to eq([
      'TypeError', true, nil, false, 'IndexSizeError', 'InvalidStateError', 'InvalidStateError',
      'InvalidNodeTypeError', 'IndexSizeError', 'TypeError',
      4, 1, 'backward', 'Range', 'ell', true, 'NotFoundError', 0, 'none', 0, true, true, false
    ])
  end

  it 'schedules selectionchange, once a task' do
    session = simulated_session(app)
    session.visit '/'
    out = run(session, <<~JS)
      const seen = [];
      document.addEventListener('selectionchange', (e) => seen.push(['document', e.bubbles, e.target === document]));
      document.body.addEventListener('selectionchange', (e) => seen.push(['body', e.target.id]));
      const spin = () => new Promise((resolve) => setTimeout(resolve));
      const sel = getSelection(), text = p.firstChild;
      sel.collapse(text, 1);
      sel.extend(text, 3);
      const sync = seen.length;
      await spin();
      const afterApi = seen.length;
      sel.getRangeAt(0).setStart(text, 0);
      await spin();
      const afterRange = seen.length;
      i.setSelectionRange(1, 2);
      await spin();
      return [sync, afterApi, afterRange, seen];
    JS
    expect(out).to eq([
      0, 1, 2,
      [['document', false, true], ['document', false, true], ['body', 'i'], ['document', true, false]]
    ])
  end

  # What the user does the driver does too, where a script's call may not: select all in a contenteditable in a shadow
  # tree. And modify() by a word, setBaseAndExtent's order of checks, a trusted selectionchange — one at a text control
  # its keys move the caret of — and another realm's document's selection.
  it 'selects as the user, and moves by words' do
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      const host = document.body.appendChild(document.createElement('div'));
      host.id = 'host';
      host.attachShadow({mode: 'open'}).innerHTML = '<div contenteditable>old text</div>';
    JS
    editor = session.find(:css, '#host').shadow_root.find(:css, '[contenteditable]')
    editor.send_keys [:control, 'a'], 'Z'
    expect(session.evaluate_script("host.shadowRoot.firstChild.textContent")).to eq('Z')
    out = run(session, <<~JS)
      const err = (f) => { try { f(); return 'none'; } catch (e) { return e.name; } };
      const sel = getSelection(), text = p.firstChild;
      const out = [err(() => sel.setBaseAndExtent(document.doctype, 1, text, 0))];
      const other = document.implementation.createHTMLDocument('');
      out.push(err(() => sel.setBaseAndExtent(text, 0, other.doctype, 0)));
      p.firstChild.data = 'abc def ghi';
      sel.collapse(text, 5);
      sel.modify('move', 'forward', 'word');
      out.push(sel.focusOffset);
      sel.modify('extend', 'backward', 'word');
      sel.modify('extend', 'backward', 'word');
      out.push(sel.focusOffset, sel.anchorOffset);
      sel.modify('move', 'bac\u212Award', 'character');
      out.push(sel.anchorOffset);
      const trusted = await new Promise((resolve) => {
        document.addEventListener('selectionchange', (e) => resolve(e.isTrusted), {once: true});
        sel.collapse(text, 1);
      });
      const frame = document.body.appendChild(document.createElement('iframe'));
      out.push(trusted, Document.prototype.getSelection.call(frame.contentDocument) === frame.contentWindow.getSelection());
      return out;
    JS
    expect(out).to eq(['IndexSizeError', 'none', 7, 0, 7, 7, true, true])
    session.execute_script(<<~JS)
      globalThis.__seen = 0;
      i.addEventListener('selectionchange', () => { globalThis.__seen++; });
    JS
    session.find(:css, '#i').send_keys(:home)
    expect(session.evaluate_script('globalThis.__seen')).to eq(1)
  end
end
