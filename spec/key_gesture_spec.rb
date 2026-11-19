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

  # An arrow passes an inline non-editable island in an editing host whole — a stop before it and one after it, the
  # latter in the text that goes on beside it — never into it (Chrome and Firefox, WPT
  # selection/caret/move-around-contenteditable-false).
  it 'moves the caret past a non-editable island whole' do
    s = session_of('<div id=e contenteditable><p>abc</p><p id=q><span contenteditable=false>def</span>ghi</p></div>')
    s.execute_script("e.focus(); getSelection().collapse(q.lastChild, 0)")
    caret = "(() => { const r = getSelection().getRangeAt(0); return [r.startContainer.nodeName, r.startOffset] })()"
    s.find('#e').send_keys(:left)
    expect(s.evaluate_script(caret)).to eq(['P', 0])
    s.find('#e').send_keys(:right)
    expect(s.evaluate_script(caret)).to eq(['#text', 0])
  end

  # Once a task between two keys focuses a child navigable's field, the keys after it go there — the focused area of the
  # document is inside the frame (UI Events; Chrome) — and a frame removed in the middle of the keys ends them, no raise.
  it 'follows focus into a frame, and ends with a frame removed' do
    s = session_of('<input id=a><iframe id=fr srcdoc="<input id=fi>"></iframe>')
    s.execute_script("a.addEventListener('keydown', (e) => { if (e.key === 'a') setTimeout(() => fr.contentDocument.getElementById('fi').focus()) })")
    s.find('#a').send_keys('abc')
    expect(s.evaluate_script("[a.value, fr.contentDocument.getElementById('fi').value]")).to eq(%w[a bc])
    s.within_frame('fr') do
      s.execute_script("document.getElementById('fi').addEventListener('keydown', () => setTimeout(() => parent.document.getElementById('fr').remove()))")
      expect { s.find('#fi').send_keys('xy') }.not_to raise_error
    end
    expect(s.all('iframe').size).to eq(0)
  end

  # A character typed at a select picks the option its text begins with — its `input` and `change` fired (Chrome and
  # Firefox); Tab past the last element leaves the document, its focused element blurred (HTML: "the user agent should
  # transfer focus to its own controls"; Chrome) — and kept as the document's focused area, `document.activeElement`,
  # with `hasFocus()` false: the SPEC over Chrome, whose `activeElement` is the body (the focus update steps designate
  # only the new chain's entries, and it is empty); undo with no history fires nothing (Chrome and Firefox).
  it 'picks by typeahead, leaves the document past the last Tab stop, and undoes nothing' do
    s = session_of('<select id=s><option>apple<option>banana<option>cherry</select><input id=z>')
    s.find('#s').send_keys('c')
    expect(s.evaluate_script('s.value')).to eq('cherry')
    expect(log(s).grep(/input|change/)).to eq(%w[input\ s change\ s])
    s.find('#z').send_keys(:tab)
    expect(s.evaluate_script('[document.activeElement.id, document.hasFocus()]')).to eq(['z', false])
    expect(log(s)).to include('blur z')
    s.find('#z').send_keys('q', [:control, 'z'])
    expect(log(s).grep(/history/)).to eq([])
  end

  # `send_keys` as Selenium sends its arguments: a modifier symbol held for every key after it, an array a chord whose
  # modifiers are released after it, and a name that names no key refused.
  it 'presses its arguments as Selenium does' do
    s = session_of('<input id=a>')
    s.find('#a').send_keys(:shift, 'a', 'b')
    s.find('#a').send_keys([:shift, 'c'], 'd')
    expect(s.evaluate_script('a.value')).to eq('ABCd')
    expect { s.find('#a').send_keys(:foo) }.to raise_error(ArgumentError, /unknown key: foo/)
  end

  # `set` on a field whose value its picker sets — a date, a time, a colour — fires `input` as a plain Event (Chrome).
  it 'sets a picked value with a plain Event input' do
    s = session_of('<input id=d type=date><input id=c type=color>')
    s.execute_script("document.addEventListener('input', (e) => L.push(e.constructor.name), true)")
    s.find('#d').set('2024-01-02')
    s.find('#c').set('#ff0000')
    expect(log(s).grep(/Event$/)).to eq(%w[Event Event])
  end

  # Sequential focus navigation across navigables (HTML §6.6.5): Tab past the last element leaves the document, the next
  # Tab coming back in at its start, Shift + Tab at its end (Chrome); a frame's order goes on into its parent's past its
  # end, and the parent's into a frame it comes to (Chrome and Firefox) — the keys after it typed there. Left, the
  # document keeps `z` its `activeElement` (the SPEC over Chrome's body: see above), and the page's keys sent to it go
  # where the focus is, the next Tab in at the start.
  it 'tabs out of the document and back, into a frame and out of it' do
    s = session_of(%(<input id=a><iframe id=fr srcdoc="<input id=in1><input id=in2>"></iframe><input id=z>))
    ae = -> { s.evaluate_script('document.activeElement.id || document.activeElement.nodeName') }
    s.find('#z').send_keys(:tab)
    r = [ae.()]
    s.send_keys(:tab)
    r << ae.()
    s.find('#z').send_keys(:tab)
    s.send_keys([:shift, :tab])
    r << ae.()
    s.find('#a').send_keys(:tab, 'x')
    r << ae.() << s.evaluate_script("fr.contentDocument.getElementById('in1').value")
    s.within_frame('fr') { s.find('#in2').send_keys(:tab) }
    expect(r << ae.()).to eq(%w[z a z fr x z])
  end

  # A gesture begun in a frame follows focus out of it to the page (Chrome); session keys read as an element's
  # (`:null` releasing the modifiers, Selenium's); and a select's typeahead search runs on across `send_keys` calls a
  # second apart at most (Chrome and Firefox: `c`, `c` steps to the second option a `c` begins).
  it 'follows focus out of a frame, reads session keys as an element\'s, and keeps a typeahead search' do
    s = session_of(%(<iframe id=fr srcdoc="<input id=in1>"></iframe><input id=after><select id=s><option>apple<option>cranberry<option>Coconut</select>))
    s.within_frame('fr') do
      s.execute_script("document.getElementById('in1').addEventListener('keydown', (e) => { if (e.key === 'a') setTimeout(() => parent.document.getElementById('after').focus()) })")
      s.find('#in1').send_keys('abc')
      expect(s.find('#in1').value).to eq('a')
    end
    expect(s.evaluate_script('after.value')).to eq('bc')
    s.send_keys(:shift, 'x', :null, 'y')
    expect(s.evaluate_script('after.value')).to eq('bcXy')
    s.find('#s').send_keys('c')
    s.find('#s').send_keys('c')
    expect(s.evaluate_script('s.value')).to eq('Coconut')
  end

  # Focus comes back into a frame whose document focused an element before (HTML returns early from the focusing steps
  # only for the top-level traversable's focused area, else runs the focus update steps up the chain), and the page's
  # keys go to the frame's field focused (Chrome and Selenium). Each window's styles current for the walk: a sheet the
  # frame was just given hides its field from it.
  # The events are HTML's focus update steps', the SPEC over Chrome 155 (CDP keys giving its window the focus first) on
  # three points. The old chain is blurred and the new one focused entry by entry, the `<iframe>` among them — "If entry
  # is an element, let blur event target be entry" — where Chrome fires nothing at it unless it was focused as itself.
  # A Document entry's Window gets its `blur` / `focus` as its document leaves the chain or joins it, the page's never
  # while the focus is in its frame (common to both chains) — where Chrome blurs the page's Window as a frame's field
  # takes the focus, and flips both Windows once more on `fr.focus()`. And a document keeps its focused area as the focus
  # leaves it (only the new chain's entries are designated) — where Chrome empties the frame's `activeElement`; it
  # matches `:focus` no more all the same (HTML §4.16.3: an element "listed in the current focus chain"). The page's
  # Window does get its `blur` as Tab takes the focus out to the user agent's controls, and its `focus` back (Chrome too).
  it 're-enters a frame, fires the frame chain\'s focus events, and types the page\'s keys there' do
    s = session_of(%(<input id=a><iframe id=fr srcdoc="<input id=p><input id=q><input id=r>"></iframe><input id=z>))
    s.execute_script(<<~JS)
      const w = fr.contentWindow, d = w.document;
      for (const t of ['focus', 'blur']) {
        w.addEventListener(t, (e) => { if (e.target === w) L.push('fr:win' + t) });
        d.addEventListener(t, (e) => L.push('fr:' + t + ' ' + e.target.id), true);
        addEventListener(t, (e) => { if (e.target === window) L.push('win' + t) });
      }
    JS
    path = -> { s.evaluate_script("[document.activeElement.id, fr.contentDocument.activeElement.id || 'BODY', fr.contentDocument.hasFocus()]") }
    s.execute_script('a.focus()')
    log(s)
    s.execute_script("const p = fr.contentDocument.getElementById('p'); p.focus(); a.focus(); p.focus()")
    expect(path.()).to eq(['fr', 'p', true])
    expect(log(s)).to eq(['blur a', 'focus fr', 'fr:winfocus', 'fr:focus p', 'fr:blur p', 'fr:winblur', 'blur fr', 'focus a', 'blur a', 'focus fr', 'fr:winfocus', 'fr:focus p'])
    s.send_keys('x', :tab)
    expect(path.()).to eq(['fr', 'q', true])
    s.execute_script("const st = fr.contentDocument.createElement('style'); st.textContent = '#r { visibility: hidden }'; fr.contentDocument.head.append(st)")
    log(s)
    s.send_keys(:tab)
    expect(path.()).to eq(['z', 'q', false])
    expect(s.evaluate_script("fr.contentDocument.querySelectorAll(':focus').length")).to eq(0)
    expect(log(s).grep(/^(fr:)?(win)?(focus|blur)/)).to eq(['fr:blur q', 'fr:winblur', 'blur fr', 'focus z'])
    # (…Tab past the last: the focus to the user agent's controls, a new chain empty — the page's Window blurred, as
    # Chrome does — and back at the start, its Window focused first)
    s.send_keys(:tab)
    expect(path.()).to eq(['z', 'q', false])
    s.send_keys(:tab)
    expect(path.()).to eq(['a', 'q', false])
    expect(log(s).grep(/^(fr:)?(win)?(focus|blur)/)).to eq(['blur z', 'winblur', 'winfocus', 'focus a'])
    s.find('#a').send_keys(:tab, 'k')
    expect(path.()).to eq(['fr', 'p', true])
    expect(s.evaluate_script("fr.contentDocument.getElementById('p').value")).to eq('xk')
    s.execute_script(<<~JS)
      a.addEventListener('keydown', () => {
        const st = fr.contentDocument.createElement('style');
        st.textContent = '#p { display: none }';
        fr.contentDocument.head.append(st);
      });
    JS
    s.find('#a').send_keys(:tab)
    expect(path.()).to eq(['fr', 'q', true])
    s.execute_script("for (const st of fr.contentDocument.querySelectorAll('style')) st.remove()")
    log(s)
    s.execute_script("fr.contentDocument.getElementById('p').focus()")
    log(s)
    s.execute_script('fr.focus()')
    r = [path.()]
    s.execute_script('a.focus()')
    expect(r << path.()).to eq([['fr', 'BODY', true], ['a', 'BODY', false]])
    expect(log(s)).to eq(['fr:blur p', 'fr:winblur', 'blur fr', 'focus a'])
  end

  # `blur()` runs HTML's unfocusing steps: "If topDocument's node navigable has system focus, then run the focusing steps
  # for topDocument's viewport" — topDocument the old chain's last entry, the top-level one. So a field blurred in a frame
  # takes the focus out of the frame to the page's viewport: the field, the frame's Window and the `<iframe>` blurred, the
  # frame's document keeping its focused area off the chain. (Chrome keeps the focus in the frame, on its viewport — the
  # SPEC over Chrome.) "If old focus target is not one of the entries in old chain, then return": blurred again, nothing.
  it 'blurs a field in a frame to the top-level document\'s viewport' do
    s = session_of(%(<input id=a><iframe id=fr srcdoc="<input id=p>"></iframe>))
    s.execute_script(<<~JS)
      const w = fr.contentWindow, d = w.document;
      for (const t of ['focus', 'blur']) {
        w.addEventListener(t, (e) => { if (e.target === w) L.push('fr:win' + t) });
        d.addEventListener(t, (e) => L.push('fr:' + t + ' ' + e.target.id), true);
        addEventListener(t, (e) => { if (e.target === window) L.push('win' + t) });
      }
      d.getElementById('p').focus();
    JS
    log(s)
    state = "[document.activeElement.nodeName, fr.contentDocument.activeElement.id, document.hasFocus(), fr.contentDocument.hasFocus(), fr.contentDocument.querySelectorAll(':focus').length]"
    s.execute_script("fr.contentDocument.getElementById('p').blur()")
    expect(s.evaluate_script(state)).to eq(['BODY', 'p', true, false, 0])
    expect(log(s)).to eq(['fr:blur p', 'fr:winblur', 'blur fr'])
    s.execute_script("fr.contentDocument.getElementById('p').blur()")
    expect(log(s)).to eq([])
  end
end
