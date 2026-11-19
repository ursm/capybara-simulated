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
end
