require 'capybara/simulated'
require_relative 'support/session_teardown'

# The UI events of the user's actions the driver plays, as a browser fires them: trusted, their view the window and
# composed (but the enter / leave ones), a click a PointerEvent counting its clicks, a pressed button in `buttons`, a
# move with no button pressed a pointer move with no button changed (-1) whose coalesced events are itself, a key's
# keypress between its keydown and its typing (UI Events' order) and canceling it canceling the typing — Enter typing
# a line break only where there are lines, Tab nothing — a right click's contextmenu and auxclick, a double click's two
# clicks and dblclick — and a drop's files the user's, unreadable while dragged over the page (HTML's protected drag
# data store).
RSpec.describe 'User action events' do
  let(:app) {
    lambda do |env|
      next [404, {}, ['']] unless env['PATH_INFO'] == '/'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <div id=host></div>
          <input id=t><textarea id=ta></textarea><div id=z style="width: 100px; height: 40px">z</div>
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
              return parts.join(' ');
            };
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu', 'auxclick', 'dblclick', 'pointermove', 'keydown', 'keypress', 'beforeinput', 'input', 'keyup']) {
              document.addEventListener(type, (e) => __log.push(describe(e)));
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
      'pointerup PointerEvent true true true 1 0 0',
      'mouseup MouseEvent true true true 1 0 0',
      'click PointerEvent true true true 1 0 0'
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
      'click PointerEvent true true true 1 0 0',
      'click PointerEvent true true true 2 0 0',
      'dblclick MouseEvent true true true 2 0 0'
    ])
  end

  it "fires a key's keypress before its typing, canceling it canceling the typing" do
    session.visit '/'
    session.find('#t').send_keys('ab', :enter)
    expect(session.find('#t').value).to eq('a')
    expect(log.grep_v(/pointer|mouse|click/)).to eq([
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
    # (…Enter a line break only where there are lines, Tab no character at all)
    session.find('#ta').send_keys('a', :enter, :tab)
    expect(session.find('#ta').value).to eq("a\n")
  end

  it "keeps a pressed button's page position after its dispatch, on a scrolled page" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.__kept = null;
      document.getElementById('far').addEventListener('mousedown', (e) => { __kept = e; __kept.during = e.pageY; });
    JS
    session.find('#far').click
    expect(session.evaluate_script('[window.scrollY > 0, __kept.pageY === __kept.during, __kept.pageY === __kept.clientY + window.scrollY]')).to eq([true, true, true])
  end

  it "makes a drop's files the user's, unreadable while dragged over the page" do
    session.visit '/'
    file = File.expand_path(__FILE__)
    session.execute_script(<<~JS)
      window.__drop = [];
      const z = document.getElementById('z');
      for (const type of ['dragenter', 'dragover', 'drop']) {
        z.addEventListener(type, (e) => {
          const f = e.dataTransfer.files[0];
          __drop.push([type, e.dataTransfer.types.join(','), e.dataTransfer.files.length, f ? f.name + ' ' + (f instanceof File) + ' ' + f.size : ''].join(' '));
          if (type === 'dragover') e.preventDefault();
        });
      }
    JS
    session.find('#z').drop(file)
    expect(session.evaluate_script('__drop')).to eq([
      'dragenter Files 0 ',
      'dragover Files 0 ',
      "drop Files 1 #{File.basename(file)} true #{File.size(file)}"
    ])
  end
end
