# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A text control's `change` is the engine's (change_on_blur.rs): armed as the control is focused, it fires as the control
# loses focus where the USER edited it since and its value is another — a script's write never counts as an edit.
RSpec.describe 'change on blur' do
  def session_for(html)
    page = "<!DOCTYPE html><meta charset=\"utf-8\"><body>#{html}"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
  end

  # Typed and blurred: `change`. A script's write, then the blur: none. Typed and typed back: none — the value is the one
  # it was focused with. Chrome 155 (real keys): ["a"].
  it 'fires as a control the user edited to another value loses focus' do
    s = session_for(<<~HTML)
      <input id=a><input id=b><input id=c value=v>
      <script>
        window.log = [];
        for (const id of ['a', 'b', 'c']) document.getElementById(id).addEventListener('change', () => log.push(id));
      </script>
    HTML
    s.find('#a').send_keys('x')
    s.execute_script('document.activeElement.blur()')
    s.find('#b').click
    s.execute_script("document.getElementById('b').value = 'y'; document.activeElement.blur()")
    s.find('#c').send_keys('x', :backspace)
    s.execute_script('document.activeElement.blur()')
    expect(s.evaluate_script('log')).to eq(['a'])
  end

  # The value compared is the one the `value` getter reads — sanitized: an "e" typed into a number field, a space into an
  # email one, leaves the value "" it was focused with, so no `change`. Chrome 155 (real keys): [[], "", ""].
  it 'compares the sanitized value' do
    s = session_for(<<~HTML)
      <input id=n type=number><input id=e type=email>
      <script>
        window.log = [];
        for (const id of ['n', 'e']) document.getElementById(id).addEventListener('change', () => log.push(id));
      </script>
    HTML
    s.find('#n').send_keys('e')
    s.execute_script('document.activeElement.blur()')
    s.find('#e').send_keys(' ')
    s.execute_script('document.activeElement.blur()')
    expect(s.evaluate_script("[log, document.getElementById('n').value, document.getElementById('e').value]")).to eq([[], '', ''])
  end

  # A focused control taken out of its document loses focus with no event (HTML's focus fixup rule; Firefox and WebKit
  # alike), and what it had armed with it: focused again and blurred, it fires none. Chrome 155 fires `change` and `blur`
  # as it is removed — a Blink behavior its own intent ("Stop sending blur events on element removal") is retiring.
  it 'forgets an edit as the focused control is removed' do
    s = session_for(<<~HTML)
      <input id=d>
      <script>
        window.log = [];
        const d = document.getElementById('d');
        for (const t of ['change', 'blur']) d.addEventListener(t, () => log.push(t));
      </script>
    HTML
    s.find('#d').send_keys('x')
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        d.remove();
        const removed = [log.slice(), document.activeElement === document.body];
        document.body.append(d);
        d.focus();
        d.blur();
        return [removed, log];
      })()
    JS
    expect(got).to eq([[[], true], ['blur']])
  end

  # A control that stops being focusable while focused loses focus by the same unfocusing steps as a blur: its `change`
  # committed before its `blur` and `focusout` — disabled at once, or moved by `moveBefore` into a hidden subtree.
  it 'commits change before blur where a focused control stops being focusable' do
    s = session_for(<<~HTML)
      <input id=a><div id=h hidden></div><input id=b>
      <script>
        window.log = [];
        for (const id of ['a', 'b']) for (const t of ['change', 'blur', 'focusout']) document.getElementById(id).addEventListener(t, () => log.push(id + ':' + t));
      </script>
    HTML
    s.find('#a').send_keys('x')
    s.execute_script("document.getElementById('a').disabled = true")
    s.find('#b').send_keys('y')
    s.execute_script("document.getElementById('h').moveBefore(document.getElementById('b'), null)")
    s.document.synchronize { s.evaluate_script('log.length') == 6 or raise Capybara::ExpectationNotMet }
    expect(s.evaluate_script('log')).to eq(%w[a:change a:blur a:focusout b:change b:blur b:focusout])
  end

  # …and one made `hidden` does too, at the rendering update (HTML's focus fixup): still focused right after the change,
  # `change`, `blur` and `focusout` once a frame has passed — `document.activeElement` the body then (Chrome 155).
  it 'loses focus at the rendering update where a focused control is hidden' do
    s = session_for(<<~HTML)
      <input id=e>
      <script>
        window.log = [];
        for (const t of ['change', 'blur', 'focusout']) e.addEventListener(t, () => log.push(t));
      </script>
    HTML
    s.find('#e').send_keys('x')
    expect(s.evaluate_script("(() => { e.hidden = true; return document.activeElement.id; })()")).to eq('e')
    s.document.synchronize { s.evaluate_script('log.length') == 3 or raise Capybara::ExpectationNotMet }
    expect(s.evaluate_script('[log, document.activeElement.tagName]')).to eq([%w[change blur focusout], 'BODY'])
  end
end
