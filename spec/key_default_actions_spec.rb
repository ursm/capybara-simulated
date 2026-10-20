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
end
