require 'capybara/simulated'
require_relative 'support/session_teardown'

# What a `<select>` reports as its value, and how a user pick changes it.
#
# The one concept underneath all of this is HTML's "option's value": the `value`
# content attribute, or — when absent — the `text` IDL (the descendant text with
# <script> subtrees skipped and ASCII whitespace stripped and collapsed). Every
# reader defers to the `option.value` getter so the derivation can't drift; the
# entry-list side is pinned in form_data_spec.rb.
#
# Every expectation below was taken from headless Chrome, not from reading the spec.
RSpec.describe 'select value (IDL)' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="hasval"><option value="  keep  ">   Foo   </option></select>
          <select id="scr"><option>A<script>var x = 1;</script>B</option></select>
          <select id="setter"><option>  Foo  Bar  </option><option>Other</option></select>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'keeps a present value attribute verbatim, whitespace and all' do
    expect(session.evaluate_script('document.getElementById("hasval").value')).to eq('  keep  ')
  end

  it "never leaks an inline <script>'s source into the value" do
    expect(session.evaluate_script('document.getElementById("scr").value')).to eq('AB')
  end

  it 'matches an assignment against the collapsed text, not the raw text' do
    expect(session.evaluate_script(<<~JS)).to eq([0, 'Foo Bar'])
      (function () {
        const s = document.getElementById('setter');
        s.value = 'Foo Bar';
        return [s.selectedIndex, s.value];
      })()
    JS
    expect(session.evaluate_script(<<~JS)).to eq([-1, ''])
      (function () {
        const s = document.getElementById('setter');
        s.value = '  Foo  Bar  ';
        return [s.selectedIndex, s.value];
      })()
    JS
  end
end

# Capybara's `Node#value` for a select mirrors the SELENIUM driver (which reads the
# `value` IDL), not rack-test (which falls back to the first option and reads raw
# option text): this is a browser-shaped driver, so real-browser semantics win where
# the two differ.
RSpec.describe 'Capybara Node#value for a select' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="size4" size="4"><option>A</option><option>B</option></select>
          <select id="disabledsel"><option disabled selected>X</option><option>Y</option></select>
          <select id="alldisabled"><option disabled>P</option><option disabled>Q</option></select>
          <select id="empty"></select>
          <select id="multi" multiple><option>R</option><option selected>  S  T  </option></select>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  def value_of(id)
    session.find(:css, "##{id}", visible: :all).value
  end

  it 'reads a selected option even when it is disabled' do
    expect(value_of('disabledsel')).to eq('X')
  end

  it 'reads empty string when nothing is selected, rather than the first option' do
    expect(value_of('size4')).to eq('')
    expect(value_of('alldisabled')).to eq('')
    expect(value_of('empty')).to eq('')
  end

  it 'collapses the text fallback of a multiple select' do
    expect(value_of('multi')).to eq(['S T'])
  end
end

# A disabled option is inert: a real browser ignores the pick entirely rather than
# selecting it. Capybara's `select_option` goes through a different entry point than
# a user click, and only the click path used to check — so `select` on a disabled
# option really did select it. Upstream's shared spec ("on a disabled option should
# not select") missed it because the value reader ALSO skipped disabled options,
# masking the bad selection behind a correct-looking read.
RSpec.describe 'picking a disabled option' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <select id="own"><option>Keep</option><option disabled>Nope</option></select>
          <select id="grp"><option>Keep</option><optgroup disabled><option>Nope</option></optgroup></select>
          <select id="multi" multiple>
            <option selected>Stay</option>
            <option disabled selected>Stuck</option>
          </select>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'leaves the selection alone when select_option targets a disabled option' do
    session.find(:css, '#own option', text: 'Nope').select_option
    expect(session.find(:css, '#own').value).to eq('Keep')
  end

  it 'treats an option in a disabled optgroup the same way' do
    session.find(:css, '#grp option', text: 'Nope').select_option
    expect(session.find(:css, '#grp').value).to eq('Keep')
  end

  # A pick is the select's own document's to restyle: one the parent's script built and moved into a frame matches
  # the frame's `option:checked` rule at its new option, through `value` and `selectedIndex` alike.
  it "restyles the options of a select in another realm's document as they are picked" do
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.body.appendChild(document.createElement('iframe'));
      f.onload = () => {
        const fd = f.contentDocument, fw = f.contentWindow;
        const s = document.createElement('select');
        s.innerHTML = '<option>a</option><option>b</option><option>c</option>';
        fd.body.append(s);
        const colors = () => [...s.options].map((o) => fw.getComputedStyle(o).color);
        s.value = 'b';
        const byValue = colors();
        s.selectedIndex = 2;
        done([byValue, colors()]);
      };
      f.srcdoc = '<!doctype html><style>option { color: rgb(0, 0, 255) } option:checked { color: rgb(255, 0, 0) }</style><body>';
    JS
    blue, red = 'rgb(0, 0, 255)', 'rgb(255, 0, 0)'
    expect(got).to eq([[blue, red, blue], [blue, blue, red]])
  end

  # An option's value is the code units the page sees, a lone surrogate one of them (DOM's string equality), and its
  # text skips only an HTML or SVG `<script>` — a MathML one is text like any other (Chrome: `aMb` is picked).
  it 'picks the option whose value is the exact string, with only HTML and SVG scripts left out of its text' do
    got = session.evaluate_script(<<~'JS')
      (() => {
        const s = document.createElement('select');
        s.innerHTML = '<option>x</option><option>y</option>';
        s.options[1].setAttribute('value', '\uD800');
        const out = [];
        s.value = '\uFFFD'; out.push(s.selectedIndex);
        s.value = '\uD800'; out.push(s.selectedIndex);
        const m = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'script');
        m.textContent = 'M';
        s.options[0].append(m);
        s.options[0].textContent = 'a'; s.options[0].append(m, 'b');
        s.value = 'aMb'; out.push(s.selectedIndex);
        return out;
      })()
    JS
    expect(got).to eq([-1, 1, 0])
  end

  # A cloned select's options are inserted into it as appending them would be — initialised from their `selected`
  # attributes, the clone's selectedness set, none of the source's script-made selection carried — and a select in a
  # template's contents, or in a DOMParser's document, is set as its options are parsed into it. Chrome: [0, 0,
  # "true,false,false", 1, "2", [1, 0]].
  it 'sets the selectedness of a cloned select and of one in a template' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const s = document.createElement('select');
        s.innerHTML = '<option>a<option>b<option>c';
        const out = [s.cloneNode(true).selectedIndex];
        s.options[1].selected = true;
        const c = s.cloneNode(true);
        out.push(c.selectedIndex, [...c.options].map((o) => o.selected).join());
        const t = document.createElement('div');
        t.innerHTML = '<template><select><option>1<option selected>2</select></template>';
        const ts = t.firstChild.content.querySelector('select');
        out.push(ts.selectedIndex, ts.value);
        const parsed = new DOMParser().parseFromString('<select><option>1<option selected>2</select><select><option>a<option>b</select>', 'text/html');
        out.push([...parsed.querySelectorAll('select')].map((x) => x.selectedIndex));
        return out;
      })()
    JS
    expect(got).to eq([0, 0, 'true,false,false', 1, '2', [1, 0]])
  end

  it 'refuses to unselect a disabled option' do
    session.find(:css, '#multi option', text: 'Stuck').unselect_option
    expect(session.find(:css, '#multi').value).to eq(['Stay', 'Stuck'])
  end
end
