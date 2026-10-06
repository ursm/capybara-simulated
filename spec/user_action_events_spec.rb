require 'capybara/simulated'
require_relative 'support/session_teardown'

# The UI events of the user's actions the driver plays, as a browser fires them: trusted, their view the window and
# composed (but the enter / leave ones), a click a PointerEvent counting its clicks, a pressed button in `buttons`, a
# move with no button pressed a pointer move with no button changed (-1) whose coalesced events are itself, a key's
# keypress between its keydown and its typing (UI Events' order) and canceling it canceling the typing — Enter typing
# a line break only where there are lines, Tab nothing, each key's typing done before the next key's — a keyboard's
# activation a click of no pointer (Enter's on the press, Space's on the release), a chord's default action unless its
# keydown was canceled — a paste a composed ClipboardEvent of a read-only DataTransfer — a right click's contextmenu and
# auxclick, a double click's two clicks and dblclick — and a drop's files the user's, unreadable while dragged over
# the page (HTML's protected drag data store) and gone once dropped.
RSpec.describe 'User action events' do
  let(:app) {
    lambda do |env|
      next [404, {}, ['']] unless env['PATH_INFO'] == '/'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <div id=host></div>
          <input id=t><textarea id=ta></textarea><button id=btn>btn</button><input id=cb type=checkbox><input id=sub type=submit><details id=d><summary id=sm>s</summary>x</details><div id=z style="width: 100px; height: 40px">z</div>
          <div style="height: 3000px"></div>
          <div id=far>far</div>
          <script>
            window.__log = [];
            const host = document.getElementById('host');
            host.attachShadow({mode: 'open'}).innerHTML = '<button id=inner>inner</button>';
            const describe = (e) => {
              const parts = [e.type, e.constructor.name, e.isTrusted, e.view === window, e.composed, e.detail];
              if (e instanceof MouseEvent) parts.push(e.button, e.buttons);
              if (e instanceof PointerEvent && e.type === 'pointermove') parts.push(e.getCoalescedEvents().length);
              if (e instanceof KeyboardEvent && e.type === 'keypress') parts.push(e.charCode);
              if (e.type === 'click') parts.push(e.pointerId, JSON.stringify(e.pointerType));
              if (e.type === 'focus') return e.type + ' ' + e.target.id + ' ' + (e.view === window);
              return parts.join(' ');
            };
            for (const type of ['focus', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu', 'auxclick', 'dblclick', 'pointermove', 'keydown', 'keypress', 'beforeinput', 'input', 'keyup']) {
              document.addEventListener(type, (e) => __log.push(describe(e)), true);
            }
            document.getElementById('t').addEventListener('keypress', (e) => { if (e.key === 'b') e.preventDefault(); });
          </script>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  def log = session.evaluate_script('__log.splice(0)')

  it "fires a click's as a browser does, a document's listener seeing one inside a shadow tree" do
    session.visit '/'
    session.find('#host').shadow_root.find('#inner').click
    expect(log).to eq([
      'pointermove PointerEvent true true true 0 -1 0 1',
      'pointerdown PointerEvent true true true 1 0 1',
      'mousedown MouseEvent true true true 1 0 1',
      'focus host true',
      'pointerup PointerEvent true true true 1 0 0',
      'mouseup MouseEvent true true true 1 0 0',
      'click PointerEvent true true true 1 0 0 1 "mouse"'
    ])
  end

  it "fires a right click's and a double click's" do
    session.visit '/'
    session.find('#z').hover
    log
    session.find('#z').right_click
    expect(log).to eq([
      'pointerdown PointerEvent true true true 1 2 2',
      'mousedown MouseEvent true true true 1 2 2',
      'contextmenu PointerEvent true true true 1 2 2',
      'pointerup PointerEvent true true true 1 2 0',
      'mouseup MouseEvent true true true 1 2 0',
      'auxclick PointerEvent true true true 1 2 0'
    ])
    session.find('#z').double_click
    expect(log.grep(/click/)).to eq([
      'click PointerEvent true true true 1 0 0 1 "mouse"',
      'click PointerEvent true true true 2 0 0 1 "mouse"',
      'dblclick MouseEvent true true true 2 0 0'
    ])
  end

  it "fires a key's keypress before its typing, canceling it canceling the typing" do
    session.visit '/'
    session.find('#t').send_keys('ab', :enter)
    expect(session.find('#t').value).to eq('a')
    expect(log.grep_v(/pointer|mouse|click/)).to eq([
      'focus t true',
      'keydown KeyboardEvent true true true 0',
      'keypress KeyboardEvent true true true 0 97',
      'beforeinput InputEvent true true true 0',
      'input InputEvent true true true 0',
      'keyup KeyboardEvent true true true 0',
      'keydown KeyboardEvent true true true 0',
      'keypress KeyboardEvent true true true 0 98',
      'keyup KeyboardEvent true true true 0',
      'keydown KeyboardEvent true true true 0',
      'keypress KeyboardEvent true true true 0 13',
      'keyup KeyboardEvent true true true 0'
    ])
    # (…Enter a line break only where there are lines, Tab no character at all, and Enter's typing done before the
    # next key's)
    session.find('#ta').send_keys('a', :enter, :tab)
    expect(session.find('#ta').value).to eq("a\n")
    session.find('#ta').send_keys('b', :enter, [:control, 'a'], 'c')
    expect(session.find('#ta').value).to eq('c')
  end

  it "fires a keyboard's activation as a click of no pointer, Space's on its release" do
    session.visit '/'
    session.find('#btn').send_keys(:enter)
    expect(log.grep(/click|pointer|mouse/)).to eq(['click PointerEvent true true true 0 0 0 -1 ""'])
    session.find('#cb').send_keys(:space)
    expect(log.grep_v(/focus/)).to eq([
      'keydown KeyboardEvent true true true 0',
      'keypress KeyboardEvent true true true 0 32',
      'keyup KeyboardEvent true true true 0',
      'click PointerEvent true true true 0 0 0 -1 ""',
      'input InputEvent true true true 0'
    ])
    expect(session.find('#cb')).to be_checked
    # (…an input button's Enter too; and Space's activation the keyup's default action)
    session.find('#sub').send_keys(:enter)
    expect(log.grep(/click/)).to eq(['click PointerEvent true true true 0 0 0 -1 ""'])
    session.execute_script("document.getElementById('cb').addEventListener('keyup', (e) => e.preventDefault())")
    session.find('#cb').send_keys(:space)
    expect(log.grep(/click/)).to eq([])
    expect(session.find('#cb')).to be_checked
    # (…a summary's toggling its details, either key)
    session.find('#sm').send_keys(:enter)
    expect(session.evaluate_script("document.getElementById('d').open")).to be(true)
    session.find('#sm').send_keys(:space)
    expect(session.evaluate_script("document.getElementById('d').open")).to be(false)
  end

  it "runs a chord's default unless its keydown was canceled, a paste a ClipboardEvent the document sees" do
    session.visit '/'
    session.execute_script(<<~JS)
      document.getElementById('ta').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'a') e.preventDefault(); });
      window.__paste = [];
      document.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        __paste.push([e.constructor.name, e.isTrusted, dt instanceof DataTransfer, dt.getData('text/plain')].join(' '));
        setTimeout(() => __paste.push('later ' + JSON.stringify(dt.getData('text/plain'))));
      });
      document.addEventListener('beforeinput', (e) => { if (e.inputType === 'insertFromPaste') __paste.push(e.inputType + ' ' + e.data); });
    JS
    session.find('#ta').send_keys('abc', [:control, 'a'], 'Z')
    expect(session.find('#ta').value).to eq('abcZ')
    session.evaluate_script("navigator.clipboard.writeText('P')")
    session.find('#host').shadow_root.find('#inner').send_keys([:control, 'v'])
    session.find('#ta').send_keys([:control, 'v'])
    expect(session.find('#ta').value).to eq('abcZP')
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 10))')
    expect(session.evaluate_script('__paste')).to eq([
      'ClipboardEvent true true P',
      'later ""',
      'ClipboardEvent true true P',
      'insertFromPaste P',
      'later ""'
    ])
  end

  it "keeps a pressed button's page position after its dispatch, on a scrolled page" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.__kept = null;
      document.getElementById('far').addEventListener('mousedown', (e) => { __kept = e; __kept.during = e.pageY; });
    JS
    session.execute_script(<<~JS)
      document.getElementById('far').addEventListener('pointermove', (e) => { window.__moved = e.getCoalescedEvents()[0].pageY === e.pageY; });
    JS
    session.find('#far').click
    expect(session.evaluate_script('[window.scrollY > 0, __kept.pageY === __kept.during, __kept.pageY === __kept.clientY + window.scrollY, __moved]')).to eq([true, true, true, true])
  end

  it "makes a drop's files the user's, unreadable while dragged over the page" do
    session.visit '/'
    file = File.expand_path(__FILE__)
    session.execute_script(<<~JS)
      window.__drop = [];
      const z = document.getElementById('z');
      for (const type of ['dragenter', 'dragover', 'drop']) {
        z.addEventListener(type, (e) => {
          const dt = e.dataTransfer, f = dt.files[0];
          __drop.push([type, dt.types.join(','), dt.files.length, dt.items[0].getAsFile() !== null, f ? f.name + ' ' + (f instanceof File) + ' ' + f.size : ''].join(' '));
          if (type === 'dragover') e.preventDefault();
          if (type === 'drop') setTimeout(() => __drop.push('after ' + dt.types.length + ' ' + dt.files.length));
        });
      }
    JS
    session.find('#z').drop(file)
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 10))')
    expect(session.evaluate_script('__drop')).to eq([
      'dragenter Files 0 false ',
      'dragover Files 0 false ',
      "drop Files 1 true #{File.basename(file)} true #{File.size(file)}",
      'after 0 0'
    ])
  end
end
