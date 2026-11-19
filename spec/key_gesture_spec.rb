require 'capybara/simulated'
require_relative 'support/session_teardown'

# The keyboard's gestures as the engine sequences them (keys.rs `KeyGesture`): a key's events in UI Events' order and
# its default actions, all in the one task, each event going where focus is — held to Chrome 155 and Firefox 146, driven
# by CDP `Input.dispatchKeyEvent` and WebDriver BiDi `input.performActions` (2026-11-19). Headless Firefox fires no focus
# events, so the focus lines are Chrome's alone; where the two differ the comment says which this follows.
RSpec.describe 'Key gestures' do
  def session_of(body)
    html = <<~HTML
      <!DOCTYPE html><meta charset=utf-8>#{body}<script>
        window.L = [];
        for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup', 'change', 'focus', 'blur', 'click', 'submit']) {
          document.addEventListener(t, (e) => {
            const at = e.target.id || e.target.nodeName;
            L.push([t, at, e.inputType, e.ctrlKey && 'C', e.shiftKey && 'S'].filter(Boolean).join(' '));
          }, true);
        }
      </script>
    HTML
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }).tap {|s| s.visit '/' }
  end

  def log(s) = s.evaluate_script('L.splice(0)')

  # Enter's line break and Tab's focus move are the key's own default actions, before its keyup — no later task — so the
  # keyup goes to the field Tab focused; a keydown listener's microtask that cancels the key (Tagify's
  # `beforeKeyDown(e).then(() => e.preventDefault())`) runs before the default all the same.
  it 'takes Enter and Tab in the key task, before their keyup' do
    s = session_of('<textarea id=t></textarea><input id=a><input id=b>')
    s.find('#t').send_keys(:enter)
    expect(log(s)).to eq(['focus t', 'keydown t', 'keypress t', 'beforeinput t insertLineBreak', 'input t insertLineBreak', 'keyup t'])
    s.find('#a').send_keys(:tab)
    expect(log(s)).to eq(['change t', 'blur t', 'focus a', 'keydown a', 'blur a', 'focus b', 'keyup b'])
    s.execute_script("for (const x of [t, b]) x.addEventListener('keydown', (e) => Promise.resolve().then(() => e.preventDefault()))")
    s.find('#t').send_keys(:enter)
    s.find('#b').send_keys(:tab)
    expect(s.evaluate_script('[t.value, document.activeElement.id]')).to eq(["\n", 'b'])
    expect(log(s).grep(/key|input/)).to eq(['keydown t', 'keyup t', 'keydown b', 'keyup b'])
  end

  # A keydown listener that moves focus takes the key's keypress, its character and its keyup with it — to the body
  # where it blurred the field: no implicit submission then, the blur committing the field's `change`.
  it 'sends the rest of a key where its keydown moved focus' do
    s = session_of('<form id=f onsubmit="event.preventDefault()"><input id=a><input id=b><button id=go>go</button></form>')
    s.execute_script("a.addEventListener('keydown', (e) => { if (e.key === 'x') b.focus(); if (e.key === 'Enter') a.blur() })")
    s.find('#a').send_keys('x')
    expect(s.evaluate_script('[a.value, b.value]')).to eq(['', 'x'])
    expect(log(s)).to eq(['focus a', 'keydown a', 'blur a', 'focus b', 'keypress b', 'beforeinput b insertText', 'input b insertText', 'keyup b'])
    s.find('#a').send_keys('q', :enter)
    expect(log(s)).to eq([
      'change b', 'blur b', 'focus a', 'keydown a', 'keypress a', 'beforeinput a insertText', 'input a insertText', 'keyup a',
      'keydown a', 'change a', 'blur a', 'keypress BODY', 'keyup BODY'
    ])
  end

  # Enter in a single-line field: a beforeinput `insertLineBreak` that inserts nothing, then the implicit submission —
  # the field's `change` committed, its form's default button clicked — which canceling it stops (Chrome; Firefox
  # submits). A checkbox, a radio button, a read-only field and a date field submit with no beforeinput; a range does
  # not (Firefox; Chrome does), nor a color or file field (Chrome opens the picker). With no default button only the
  # one field that blocks implicit submission submits it (Chrome; Firefox from a checkbox beside it too).
  it 'submits a form implicitly from the fields Enter submits from' do
    s = session_of(<<~HTML)
      <form id=f onsubmit="event.preventDefault()"><input id=a><input id=c type=checkbox><input id=r type=radio>
      <input id=ro readonly><input id=d type=date><input id=g type=range><input id=k type=color><button id=go>go</button></form>
      <form id=f2 onsubmit="event.preventDefault()"><input id=c2 type=checkbox><input id=t2></form>
    HTML
    s.find('#a').send_keys('q', :enter)
    expect(log(s).drop(6)).to eq(['keydown a', 'keypress a', 'beforeinput a insertLineBreak', 'change a', 'click go', 'submit f', 'keyup a'])
    submitted = %w[c r ro d g k c2 t2].to_h {|id|
      s.find("##{id}").send_keys(:enter)
      [id, log(s).include?("submit #{id.end_with?('2') ? 'f2' : 'f'}")]
    }
    expect(submitted).to eq('c' => true, 'r' => true, 'ro' => true, 'd' => true, 'g' => false, 'k' => false, 'c2' => false, 't2' => true)
    s.execute_script("a.addEventListener('beforeinput', (e) => e.preventDefault())")
    s.find('#a').send_keys(:enter)
    expect(log(s).grep(/submit|click/)).to eq([])
  end

  # The `input` of a value the user changed other than by editing its text is a plain Event — HTML's "fire an event
  # named input", bubbling and composed: a checkbox's, a select's picked by an arrow, a number field's stepped (Chrome;
  # Firefox's stepper fires an InputEvent).
  it "fires a picked or stepped value's input as a plain Event" do
    s = session_of('<input id=c type=checkbox><select id=s><option>a<option>b</select><input id=n type=number value=5>')
    s.execute_script("document.addEventListener('input', (e) => L.push(e.constructor.name + ' ' + e.composed), true)")
    %w[c s n].zip([:space, :down, :up]).each {|id, key| s.find("##{id}").send_keys(key) }
    expect(log(s).grep(/^(Event|InputEvent) /)).to eq(['Event true', 'Event true', 'Event true'])
    # (…`set`'s too, of a picked option — a typed text's an InputEvent)
    s.find('#s').set('a')
    s.find('#n').set('7')
    expect(log(s).grep(/^(Event|InputEvent) /)).to eq(['Event true', 'InputEvent true'])
  end

  # Space activates the element its keydown went to on its release — none where a keydown listener moved focus, though
  # its keypress and keyup go where focus went (Chrome) — and `set("…\n")` submits from a field it typed into, not from
  # a checkbox whose value it wrote.
  it 'activates and submits only what the key was pressed at' do
    s = session_of('<form id=f onsubmit="event.preventDefault()"><input id=c type=checkbox><button id=b type=button>b</button><button id=go>go</button></form>')
    s.execute_script("c.addEventListener('keydown', () => b.focus())")
    s.find('#c').send_keys(:space)
    expect(log(s).grep(/click|key/)).to eq(['keydown c', 'keypress b', 'keyup b'])
    s.find('#c').set("on\n")
    expect(log(s).grep(/submit/)).to eq([])
  end

  # A chord's modifier keys each carry the modifiers held as it goes down or up — itself among them going down — its key
  # all of them; Control + A selects all at its keydown, before its keyup reads the selection; Control + Shift + A
  # selects nothing, and a chord of a modifier alone presses no other key.
  it 'holds a chord as a keyboard does' do
    s = session_of('<input id=a value=hello>')
    s.execute_script("a.addEventListener('keyup', (e) => L.push('sel ' + a.selectionStart + '-' + a.selectionEnd))")
    s.find('#a').send_keys([:control, :shift, 'a'])
    expect(log(s).drop(1)).to eq(['keydown a C', 'keydown a C S', 'keydown a C S', 'keyup a C S', 'sel 5-5', 'keyup a C', 'sel 5-5', 'keyup a', 'sel 5-5'])
    s.find('#a').send_keys([:control, 'a'])
    expect(log(s)).to eq(['keydown a C', 'keydown a C', 'keyup a C', 'sel 0-5', 'keyup a', 'sel 0-5'])
    s.find('#a').send_keys([:control])
    expect(log(s)).to eq(['keydown a C', 'keyup a', 'sel 0-5'])
  end

  # A keydown and a keyup are tasks of their own: what a keydown queued that is due runs before its keyup, and a key's
  # tasks before the next key's (Chrome and Firefox: a 0 ms timer, a `select` event).
  it 'runs the tasks a keydown queued before its keyup' do
    s = session_of('<input id=a value=hello>')
    s.execute_script(<<~JS)
      a.addEventListener('keydown', (e) => setTimeout(() => L.push('timer ' + e.key)));
      a.addEventListener('select', () => L.push('select'));
    JS
    s.find('#a').send_keys('x', [:control, 'a'])
    expect(log(s).grep(/timer|select|keyup/)).to eq(['timer x', 'keyup a', 'timer Control', 'timer a', 'select', 'keyup a C', 'keyup a'])
  end

  # A key WebDriver's table names — a function key, Insert, a numpad key — has its `key`, `code` and `location`: a
  # function key types nothing, a numpad digit its digit (Firefox, which implements the table).
  it 'presses the keys WebDriver names as their key and code' do
    s = session_of('<input id=a>')
    s.execute_script("a.addEventListener('keydown', (e) => L.push([e.key, e.code, e.keyCode, e.location].join(' ')))")
    s.find('#a').send_keys(:f5, :insert, :numpad7, [:right_shift, 'b'])
    expect(log(s).grep(/^\S+ \S+ \d+ \d$/)).to eq(['F5 F5 116 0', 'Insert Insert 45 0', '7 Numpad7 103 3', 'Shift ShiftRight 16 2', 'B KeyB 66 0'])
    expect(s.evaluate_script('a.value')).to eq('7B')
  end

  # Control + B in an editing host bolds the selection as a user's command — its beforeinput targeting the selection,
  # the edit, its input (Chrome) — and Backspace's beforeinput targets the range it deletes (Chrome and Firefox).
  it 'formats and deletes in an editing host with their target ranges' do
    s = session_of('<div id=e contenteditable>abc</div>')
    s.execute_script(<<~JS)
      e.addEventListener('beforeinput', (ev) => L.push('ranges ' + ev.getTargetRanges().map((r) => r.startContainer.nodeName + r.startOffset + '-' + r.endContainer.nodeName + r.endOffset).join()));
      e.focus(); getSelection().setBaseAndExtent(e.firstChild, 0, e.firstChild, 2);
    JS
    s.find('#e').send_keys([:control, 'b'])
    expect(s.evaluate_script('e.innerHTML')).to eq('<b>ab</b>c')
    expect(log(s).grep(/input|ranges/)).to eq(['beforeinput e formatBold', 'ranges #text0-#text2', 'input e formatBold'])
    s.execute_script("e.innerHTML = 'abc'; getSelection().collapse(e.firstChild, 2)")
    s.find('#e').send_keys(:backspace)
    expect(log(s).grep(/ranges/)).to eq(['ranges #text1-#text2'])
    expect(s.evaluate_script('e.innerHTML')).to eq('ac')
  end
end
