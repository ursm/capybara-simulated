require 'capybara/simulated'
require_relative 'support/session_teardown'

# The events the UA fires itself are trusted, and are dispatched by its steps — not through a `dispatchEvent` a page
# may have replaced, which reports them untrusted (HTML "fire an event"): a fragment navigation's `hashchange`, a
# history traversal's `popstate`, a frame's `load`, an image's `error` — and `unhandledrejection` reaches
# `onunhandledrejection` once, as one of the window's listeners. And the events a script's call makes the UA fire —
# `focus()`'s, `checkValidity()`'s `invalid`, a popover's `toggle` (Chrome), `new FormData(form)`'s `formdata`,
# `execCommand()`'s `input`. And the events of the user's actions the driver plays — a drop's DragEvents, the drop
# itself only where `dragover` was canceled — and the UA's in answer to them: a button's `submit`, interactive
# validation's `invalid`.
RSpec.describe 'UA-fired events' do
  let(:app) {
    lambda do |env|
      next [404, {}, ['']] unless env['PATH_INFO'] == '/'
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <iframe id=f srcdoc="<p>x"></iframe><img id=i src="/missing.png">
          <input id=t><input id=r required><div id=p popover></div>
          <form id=fm><input id=u name=u><select id=s name=s><option>a<option>b</select></form>
          <div id=h>h</div><div id=ce contenteditable>c</div>
          <form id=fs><button>go</button></form><form id=fv><input required><button>check</button></form>
          <script>
            window.__trust = {};
            window.dispatchEvent = () => { throw new Error('the page\\'s dispatchEvent'); };
            addEventListener('hashchange', (e) => { __trust.hashchange = e.isTrusted; });
            addEventListener('popstate', (e) => { __trust.popstate = e.isTrusted; });
            addEventListener('pageshow', (e) => { __trust.pageshow = e.isTrusted && e instanceof PageTransitionEvent && e.persisted === false; });
            document.getElementById('f').addEventListener('load', (e) => { __trust.frameLoad = e.isTrusted; });
            document.getElementById('i').addEventListener('error', (e) => { __trust.imageError = e.isTrusted; });
            __trust.unhandled = 0;
            window.onunhandledrejection = (e) => { __trust.unhandled++; e.preventDefault(); };
            Promise.reject(new Error('x'));
            document.getElementById('t').addEventListener('focus', (e) => { __trust.focus = e.isTrusted; });
            document.getElementById('t').focus();
            document.getElementById('r').addEventListener('invalid', (e) => { __trust.invalid = e.isTrusted; });
            document.getElementById('r').checkValidity();
            document.getElementById('p').addEventListener('toggle', (e) => { __trust.toggle = e.isTrusted; });
            document.getElementById('p').showPopover();
            location.hash = '#a';
            history.pushState({}, '', '#b');
            history.back();
            window.__seen = {};
            for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup', 'change', 'pointerover', 'mouseover', 'mousemove', 'formdata', 'submit', 'invalid', 'dragenter', 'dragover', 'drop', 'dragleave']) {
              document.addEventListener(type, (e) => {
                __seen[type] = (__seen[type] ?? true) && e.isTrusted && (!type.startsWith('drag') && type !== 'drop' || e instanceof DragEvent);
                if (type === 'submit' || type === 'dragover' && e.target.id === 'h') e.preventDefault();
                if (type === 'drop' || type === 'dragleave') __seen.dropped = [...(__seen.dropped || []), `${e.target.id} ${type}`];
              }, true);
            }
          </script>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  it 'fires them trusted, by the steps' do
    session.visit '/'
    session.evaluate_script('new Promise((resolve) => setTimeout(resolve, 200))')
    expect(session.evaluate_script('window.__trust')).to eq(
      'hashchange' => true, 'popstate' => true, 'pageshow' => true, 'frameLoad' => true, 'imageError' => true, 'unhandled' => 1,
      'focus' => true, 'invalid' => true, 'toggle' => true
    )
  end

  it "fires the user's actions' trusted, and those of a script's call that the UA fires" do
    session.visit '/'
    session.fill_in 'u', with: 'x'
    session.find('#u').send_keys('z')
    session.select 'b', from: 's'
    session.find('#h').hover
    session.click_button 'go'
    session.click_button 'check'
    session.find('#h').drop('text/plain' => 'd')
    session.find('#ce').drop('text/plain' => 'd')
    session.execute_script(<<~JS)
      new FormData(document.getElementById('fm'));
      document.getElementById('ce').focus();
      document.execCommand('insertText', false, 'y');
    JS
    expect(session.evaluate_script('window.__seen')).to eq(
      'keydown' => true, 'keypress' => true, 'beforeinput' => true, 'input' => true, 'keyup' => true, 'change' => true,
      'pointerover' => true, 'mouseover' => true, 'mousemove' => true, 'formdata' => true, 'submit' => true,
      'invalid' => true, 'dragenter' => true, 'dragover' => true, 'drop' => true, 'dragleave' => true,
      'dropped' => ['h drop', 'ce dragleave']
    )
  end
end
