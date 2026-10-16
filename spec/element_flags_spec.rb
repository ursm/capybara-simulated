require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# What an element's own steps keep about it (element_flags.rs, frame_navigation.rs): each kept for as long as what it is
# about lasts. Chrome's figures.
RSpec.describe 'element flags' do
  include PollUntil

  def session
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    s
  end

  # HTML "update a style block" queues a `load` for every sheet it makes: inserted, its text changed, inserted again.
  it "fires a style's load for each sheet it gets" do
    s = session
    s.execute_script('window.L = []; const st = document.createElement("style"); st.onload = () => L.push(st.textContent); st.textContent = "p{}"; document.head.append(st); window.st = st')
    poll_until { s.evaluate_script('L.length') == 1 }
    s.execute_script('st.textContent = "p{color:red}"')
    poll_until { s.evaluate_script('L.length') == 2 }
    s.execute_script('st.remove(); document.head.append(st)')
    expect(poll_until { s.evaluate_script('L.length >= 3 && L') }).to eq(['p{}', 'p{color:red}', 'p{color:red}'])
  end

  # A frame removed has no browsing context; inserted again it gets one at its own post-insertion step, so a script
  # inserted before it in the same batch reads none — as it did the first time.
  it "gives a frame inserted again no browsing context before its post-insertion step" do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq([true, true, true])
      (() => {
        window.CW = [];
        const script = (text) => { const e = document.createElement('script'); e.textContent = text; return e; };
        const f = document.createElement('iframe');
        f.id = 'nf';
        const d = document.createElement('div');
        d.append(script('CW.push(document.getElementById("nf").contentWindow === null)'), f, script('CW.push(document.getElementById("nf").contentWindow !== null)'));
        document.body.append(d);
        f.remove();
        const d2 = document.createElement('div');
        d2.append(script('CW.push(document.getElementById("nf").contentWindow === null)'), f);
        document.body.append(d2);
        return CW;
      })()
    JS
  end

  # An element whose upgrade failed (custom element state "failed") keeps its class's interface: it is no
  # HTMLUnknownElement, which the element a failed construction makes in its stead is.
  it 'keeps the interface of an element whose upgrade failed' do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq([false, true])
      (() => {
        const errors = [];
        window.addEventListener('error', (e) => { errors.push(e); e.preventDefault(); });
        customElements.define('x-up', class extends HTMLElement { constructor() { super(); throw new Error('upgrade'); } });
        const holder = document.createElement('div');
        holder.innerHTML = '<x-up></x-up>';
        const upgraded = holder.firstChild;
        document.body.append(holder);
        customElements.define('x-made', class extends HTMLElement { constructor() { throw new Error('made'); } });
        const made = document.createElement('x-made');
        return [upgraded instanceof HTMLUnknownElement, made instanceof HTMLUnknownElement];
      })()
    JS
  end
end
