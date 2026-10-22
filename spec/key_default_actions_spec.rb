require 'capybara/simulated'
require_relative 'support/session_teardown'

# The default actions the driver's key presses take — the engine's key plan (keys.rs `plan`): Tab's focus navigation,
# Control / Meta + A's select-all, the clipboard chords' cut, copy and paste — and what each acts on.
RSpec.describe 'Key default actions' do
  def session_of(body)
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }).tap {|s| s.visit '/' }
  end

  # A cut or a paste edits only what its command acts on (editing_commands.rs `command_target`, Blink's CanCut /
  # CanPaste): a read-only control's `cut` and `paste` fire, and nothing is deleted, written or inserted; a cut of
  # nothing selected writes nothing.
  it 'cuts and pastes nothing in a read-only control, and nothing from a collapsed selection' do
    s = session_of('<input id=ro readonly value=RO><input id=w value=abc>')
    s.execute_script("window.L = []; for (const t of ['cut', 'paste', 'input']) document.addEventListener(t, (e) => L.push(t + ':' + e.target.id))")
    s.execute_script('navigator.clipboard.writeText("kept")')
    s.execute_script('ro.focus(); ro.setSelectionRange(0, 2)')
    s.find('#ro').send_keys([:control, 'x'])
    s.find('#ro').send_keys([:control, 'v'])
    s.execute_script('w.focus(); w.setSelectionRange(1, 1)')
    s.find('#w').send_keys([:control, 'x'])
    got = s.evaluate_async_script('const done = arguments[0]; navigator.clipboard.readText().then((t) => done([ro.value, w.value, t, L]))')
    expect(got).to eq(['RO', 'abc', 'kept', %w[cut:ro paste:ro cut:w]])
  end

  # Control + A selects all of a read-only control's text too, and the document's where nothing editable is focused
  # (Chrome's SelectAll).
  it "selects all of a read-only control, and the document's elsewhere" do
    s = session_of('<input id=ro readonly value=hello><p>text</p>')
    s.find('#ro').send_keys([:control, 'a'])
    expect(s.evaluate_script('[ro.selectionStart, ro.selectionEnd]')).to eq([0, 5])
    s.find('body').send_keys([:control, 'a'])
    expect(s.evaluate_script('getSelection().toString()')).to include('text')
  end

  # The session's Tab is a key as any: its keydown fires, and a listener canceling it keeps the focus where it is.
  it "fires the session's Tab's keydown, which a listener may cancel" do
    s = session_of('<input id=a><input id=b>')
    s.execute_script("a.focus(); window.L = []; document.addEventListener('keydown', (e) => { L.push(e.key); if (window.cancelTab) e.preventDefault(); })")
    # (…focus moved as the key's task runs, a step after the key)
    focused = lambda {|id| s.document.synchronize { s.evaluate_script('document.activeElement.id') == id or raise Capybara::ExpectationNotMet } }
    s.send_keys(:tab)
    focused.call('b')
    expect(s.evaluate_script('L')).to eq(['Tab'])
    s.execute_script('a.focus(); window.cancelTab = true')
    s.send_keys(:tab)
    focused.call('a')
    expect(s.evaluate_script('L')).to eq(%w[Tab Tab])
  end

  # A character past U+FFFF typed into an editing host is one key: one keypress, its char code the code point, and the
  # character inserted whole.
  it 'types a character past U+FFFF into an editing host as one key' do
    s = session_of('<div id=ed contenteditable></div>')
    s.execute_script("window.L = []; ed.addEventListener('keypress', (e) => L.push(e.charCode))")
    s.find('#ed').set("a\u{1F600}")
    expect(s.evaluate_script('[ed.textContent, L]')).to eq(["a\u{1F600}", [97, 0x1F600]])
  end

  # An email field is a text control to its chords too: Control + A selects its text, which the next key types over,
  # and Control + V pastes over it (Chrome) — never the page's text selected instead.
  it 'selects all of an email field and pastes into it' do
    s = session_of('<input id=e type=email value=a@b.c><input id=f type=email value=old@b.c><p>para text</p>')
    s.find('#e').send_keys([:control, 'a'], 'x@y.z')
    s.execute_script('navigator.clipboard.writeText("new@b.c")')
    s.find('#f').send_keys([:control, 'a'], [:control, 'v'])
    expect(s.evaluate_script('[e.value, f.value, getSelection().toString()]')).to eq(['x@y.z', 'new@b.c', ''])
  end

  # `set` on an editing host types its value as `send_keys` does, key by key through the same pipeline: each key's
  # keypress with its `code`, a line feed Enter — a paragraph inserted, not a line feed character — and Shift, a
  # modifier held as a chord holds it (`[:shift, 'ab']`), the same keys.
  it 'types a contenteditable value key by key as send_keys does' do
    s = session_of('<div id=ed contenteditable>old</div>')
    s.execute_script(<<~JS)
      window.L = [];
      for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']) {
        ed.addEventListener(t, (e) => L.push(t + ':' + (e.code ?? e.inputType)));
      }
    JS
    s.find('#ed').set("a\nb")
    got = s.evaluate_script('[L, ed.innerHTML]')
    expect(got[0].first(5)).to eq(%w[keydown:KeyA keypress:KeyA beforeinput:insertText input:insertText keyup:KeyA])
    expect(got[0]).to include('beforeinput:insertParagraph', 'input:insertParagraph')
    expect(got[1]).not_to include('old')
    expect(got[1]).not_to include("\n")
  end

  # The keys after a Tab go to the element it focused, as a keyboard's go to the focused one — a Tab in a `set`
  # value too — and a key's keypress and keyup go where its keydown went while focus stays put: to a paragraph of an
  # editing host, which takes no focus, not to a field that merely held it.
  it 'sends the keys after a Tab to what it focused, and a key to one element while focus stays' do
    s = session_of('<input id=a><input id=b><div contenteditable><p id=p>old</p></div>')
    s.find('#a').send_keys('x', :tab, 'y')
    expect(s.evaluate_script('[a.value, b.value, document.activeElement.id]')).to eq(%w[x y b])
    s.execute_script("window.L = []; for (const t of ['keydown', 'keypress', 'keyup']) document.addEventListener(t, (e) => L.push(t + ':' + e.target.id), true)")
    s.find('#p').set('z')
    expect(s.evaluate_script('L')).to eq(%w[keydown:p keypress:p keyup:p])
    # (…and once a listener moves focus, the next key goes to the element it focused — all of its events)
    s.execute_script("L.length = 0; a.value = b.value = ''; a.addEventListener('keydown', () => b.focus(), {once: true})")
    s.find('#a').send_keys('c', 'd')
    expect(s.evaluate_script('[b.value.endsWith("d"), L.slice(3)]')).to eq([true, %w[keydown:b keypress:b keyup:b]])
  end

  # A cut deletes an editing host's selection as Delete does — the blocks it spans merged — by the accelerator and by
  # `execCommand('cut')` alike.
  it "cuts a selection across blocks as Delete deletes it" do
    s = session_of('<div id=ed contenteditable><p>ab</p><p>cd</p></div>')
    select = 'const t = ed.querySelectorAll("p"); getSelection().setBaseAndExtent(t[0].firstChild, 1, t[1].firstChild, 1)'
    deleted = s.evaluate_script("(() => { ed.focus(); #{select}; document.execCommand('delete'); const h = ed.innerHTML; ed.innerHTML = '<p>ab</p><p>cd</p>'; return h })()")
    cut = s.evaluate_script("(() => { #{select}; document.execCommand('cut'); const h = ed.innerHTML; ed.innerHTML = '<p>ab</p><p>cd</p>'; return h })()")
    s.execute_script(select)
    s.find('#ed').send_keys([:control, 'x'])
    expect([cut, s.evaluate_script('ed.innerHTML')]).to eq([deleted, deleted])
    expect(deleted).to eq('<p>ad</p>')
  end

  # `set("…\n")` types the value and then presses Enter: the line feed is no part of the value, so a number field's
  # `change` reports what it holds.
  it 'sets a number field to the value before its trailing line feed' do
    s = session_of('<form><input id=n type=number></form>')
    s.execute_script("window.L = []; n.addEventListener('change', () => L.push(n.value)); n.form.addEventListener('submit', (e) => { e.preventDefault(); L.push('submit') })")
    s.find('#n').set("5\n")
    expect(s.evaluate_script('L')).to eq(%w[5 submit])
  end
end
