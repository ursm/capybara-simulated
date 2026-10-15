require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A history traversal back to a document puts its controls' persisted user state back (HTML §7.4.6.2): the values,
# checkedness and selected options they were left with, not their defaults. What the autofill processing model keeps a
# control from remembering (§4.10.18.7.1) — its own `autocomplete=off`, its form owner's where it says neither — it does
# not get back, nor does a password field; and a value in the "default" mode (a hidden field's) is its attribute, which
# the document fetched again has. Measured in Chrome 155 (an `unload` listener keeping it out of the back/forward
# cache): b1, b5, b6 and the selects come back, a1, b2, b3 and b4 do not. Chrome also forgets a2 — an `on` in a form
# that says `off` — whose autofill field name the spec makes "on".
RSpec.describe 'persisted form state' do
  let(:page) do
    <<~HTML
      <!DOCTYPE html>
      <form autocomplete="off"><input id="a1"><input id="a2" autocomplete="on"></form>
      <form>
        <input id="b1"><input id="b2" autocomplete="off"><input id="b3" type="password"><input id="b4" type="hidden" value="h">
        <textarea id="b5"></textarea><input id="b6" type="checkbox">
        <select id="s1"><option>x</option><option>y</option></select>
        <select id="s2" multiple><option>x</option><option selected>y</option><option>z</option></select>
      </form>
      <a href="/other">away</a>
    HTML
  end

  it 'puts back what each control may remember' do
    doc = page
    app = lambda {|env| [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/other' ? '<p>other</p>' : doc]] }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      for (const id of ['a1', 'a2', 'b1', 'b2', 'b3', 'b5']) document.getElementById(id).value = 'X' + id;
      document.getElementById('b4').value = 'changed';
      document.getElementById('b6').checked = true;
      document.getElementById('s1').value = 'y';
      const s2 = document.getElementById('s2');
      s2.options[0].selected = true; s2.options[1].selected = false; s2.options[2].selected = true;
    JS
    s.click_link 'away'
    s.go_back
    read = <<~JS
      [...document.querySelectorAll('input, textarea, select')].map((c) =>
        c.id + '=' + (c.type === 'checkbox' ? c.checked : c.multiple ? [...c.selectedOptions].map((o) => o.value).join() : c.value))
    JS
    expect(s.evaluate_script(read)).to eq(%w[a1= a2=Xa2 b1=Xb1 b2= b3= b4=h b5=Xb5 b6=true s1=y s2=x,z])
  end

  # A form-associated custom element's state — what its internals' `setFormValue` was last given as its state, else its
  # value — comes back to its formStateRestoreCallback with "restore": a string, or a FormData. `autocomplete` does not
  # apply to one; its form owner's `off` keeps it. Chrome 155, the same page: f1 state1, f2 state2, f3 FormData a=b,
  # f5 v5, and nothing for f4.
  it "hands a form-associated custom element's state back to it" do
    face = <<~HTML
      <!DOCTYPE html>
      <script>
        window.log = [];
        customElements.define('my-face', class extends HTMLElement {
          static formAssociated = true;
          constructor() { super(); this.i = this.attachInternals(); }
          formStateRestoreCallback(state, mode) {
            log.push([this.id, state instanceof FormData ? [...state].join(';') : state, mode].join(' '));
          }
        });
      </script>
      <form><my-face id="f1"></my-face><my-face id="f2" autocomplete="off"></my-face><my-face id="f3"></my-face></form>
      <form autocomplete="off"><my-face id="f4"></my-face></form><my-face id="f5"></my-face>
      <a href="/other">away</a>
    HTML
    app = lambda {|env| [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/other' ? '<p>other</p>' : face]] }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script(<<~JS)
      const f = (id) => document.getElementById(id).i;
      f('f1').setFormValue('v1', 'state1'); f('f2').setFormValue('v2', 'state2');
      const fd = new FormData(); fd.append('a', 'b'); f('f3').setFormValue('v3', fd);
      f('f4').setFormValue('v4', 'state4'); f('f5').setFormValue('v5');
    JS
    s.click_link 'away'
    s.go_back
    expect(s.evaluate_script('log')).to eq(['f1 state1 restore', 'f2 state2 restore', 'f3 a,b restore', 'f5 v5 restore'])
  end

  # …and one defined only after its document is traversed back to — after the restore — is handed its state as it is
  # upgraded (Chrome restores it on upgrade), in its place among the elements that may be one; its own `autocomplete`
  # no more its say before it is defined than after.
  it 'hands a form-associated custom element defined later its state as it is upgraded' do
    late = <<~HTML
      <!DOCTYPE html>
      <x-plain></x-plain><form><my-late id="o" autocomplete="off"></my-late></form><my-late id="l"></my-late>
      <script>
        window.log = [];
        setTimeout(() => customElements.define('my-late', class extends HTMLElement {
          static formAssociated = true;
          constructor() { super(); this.i = this.attachInternals(); }
          formStateRestoreCallback(state, mode) { log.push(this.id + ' ' + state + ' ' + mode); }
        }), 0);
      </script>
      <a href="/other">away</a>
    HTML
    app = lambda {|env| [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/other' ? '<p>other</p>' : late]] }
    s = simulated_session(app)
    s.visit '/'
    s.execute_script("document.getElementById('o').i.setFormValue('v', 'so'); document.getElementById('l').i.setFormValue('v', 'st')")
    s.click_link 'away'
    s.go_back
    expect(s.evaluate_script('log')).to eq(['o so restore', 'l st restore'])
  end
end
