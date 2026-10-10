require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# `new FormData(form)` must mirror real-browser submission semantics:
# the option's `value` attribute, NOT its visible text. Most apps put
# a placeholder option like `<option value="">Choose...</option>`
# first, expecting an empty submitted value when nothing is picked —
# coercing that to "Choose..." breaks the server side (e.g. Avo's
# friendly_id lookup raises "can't find record").
RSpec.describe 'FormData serialization' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <form id="f">
            <select name="placeholder">
              <option value="">Choose an option</option>
              <option value="a">Alpha</option>
            </select>
            <select name="missing-attr">
              <option>FromText</option>
              <option>OtherText</option>
            </select>
            <select name="picked">
              <option value="">none</option>
              <option value="b" selected>Beta</option>
            </select>
          </form>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  def fd_get(name)
    session.evaluate_script(<<~JS)
      (function () {
        const fd = new FormData(document.getElementById('f'));
        return fd.get(#{name.to_json});
      })()
    JS
  end

  it 'serializes an explicit empty value attribute as empty string' do
    expect(fd_get('placeholder')).to eq('')
  end

  it 'falls back to the option text when the value attribute is missing' do
    expect(fd_get('missing-attr')).to eq('FromText')
  end

  it 'serializes the explicitly selected option' do
    expect(fd_get('picked')).to eq('b')
  end
end

# Constructing the entry list (`new FormData(form)` / form submission) fires a
# `formdata` event so listeners can mutate the set, converts each name/value to
# Unicode scalar values (unpaired surrogate → U+FFFD), and gives a `_charset_`
# control the encoding. The WPT tests for this (constructing-form-data-set,
# form-data-set-usv) currently can't reach it — they build the FormData from a
# cross-realm iframe form, or submit through a delayed-navigation path — so these
# pin the behaviour directly.
RSpec.describe 'FormData "formdata" event, USV conversion, _charset_' do
  let(:app) {
    ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'fires a bubbling, non-cancelable formdata event whose mutations land in the entry list' do
    result = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('form');
        f.innerHTML = '<input name=n1 value=v1>';
        document.body.appendChild(f);
        let fired = 0, bubbles = null, cancelable = null;
        f.addEventListener('formdata', (e) => {
          fired++; bubbles = e.bubbles; cancelable = e.cancelable;
          e.formData.append('added', 'x');
        });
        const fd = new FormData(f);
        return { fired, bubbles, cancelable, n1: fd.get('n1'), added: fd.get('added') };
      })()
    JS
    expect(result).to eq('fired' => 1, 'bubbles' => true, 'cancelable' => false, 'n1' => 'v1', 'added' => 'x')
  end

  # Each field's value is the one its `value` getter returns, sanitized for its type (HTML "construct the entry list":
  # "the value of the field element"). Chrome 2026-10-10: the same seven.
  it "takes each field's value sanitized for its type" do
    result = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('form');
        f.innerHTML = '<input type=email name=e value=" a@b "><input type=number name=n value="1x">' +
          '<input type=color name=c value="#ABCDEF"><input name=t value="a\\nb">' +
          '<input type=range name=r min=0 max=10 value=50><input type=date name=d value="2020-13-01">' +
          '<input type=hidden name=h value=" kept ">';
        document.body.appendChild(f);
        return [...new FormData(f)];
      })()
    JS
    expect(result).to eq([%w[e a@b], ['n', ''], %w[c #abcdef], %w[t ab], %w[r 10], ['d', ''], ['h', ' kept ']])
  end

  # The controls an entry list takes are the form's by its form owner — the parser's form element pointer's too
  # (`<table><form>…<input>`, foster-parented out of the form) — a detached form's its own subtree's, none in a
  # `<datalist>`, and a disabled one only as the submitter (HTML "construct the entry list").
  it 'takes the controls whose form owner the form is' do
    session.execute_script(<<~JS)
      document.body.insertAdjacentHTML('beforeend',
        '<table><form id=t><tr><td><input name=fostered value=1></td></tr></form></table>');
    JS
    got = session.evaluate_script(<<~JS)
      (() => {
        const detached = document.createElement('form');
        detached.innerHTML = '<input name=a value=1><datalist><input name=b value=2></datalist>' +
          '<button name=s value=go disabled>s</button><input name=d value=3 disabled>';
        const entries = (fd) => [...fd].map((e) => e.join('=')).join('&');
        return [entries(new FormData(t)), entries(new FormData(detached, detached.querySelector('button')))];
      })()
    JS
    expect(got).to eq(['fostered=1', 'a=1&s=go'])
  end

  it 'gives a hidden _charset_ control the UTF-8 encoding name' do
    charset = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('form');
        f.innerHTML = '<input type=hidden name=_charset_>';
        document.body.appendChild(f);
        return new FormData(f).get('_charset_');
      })()
    JS
    expect(charset).to eq('UTF-8')
  end

  it 'emits coordinate entries for an image-button submitter, named or not' do
    entries = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('form');
        f.innerHTML = '<input type=image name=pic><input type=image>';
        document.body.appendChild(f);
        const named    = f.querySelector('input[name=pic]');
        const nameless = f.querySelectorAll('input[type=image]')[1];
        const collect  = (submitter) => Array.from(new FormData(f, submitter).entries());
        return { named: collect(named), nameless: collect(nameless) };
      })()
    JS
    # An image button contributes only when it IS the submitter: `<name>.x`/`.y`,
    # or bare `x`/`y` when it has no name. The other image button stays out.
    expect(entries['named']).to eq([['pic.x', '0'], ['pic.y', '0']])
    expect(entries['nameless']).to eq([['x', '0'], ['y', '0']])
  end

  it 'converts an unpaired surrogate in a control name to U+FFFD' do
    key_codes = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('form');
        const i = document.createElement('input');
        i.name = 'n' + String.fromCharCode(0xD800);   // lone high surrogate
        i.value = 'v';
        f.appendChild(i);
        document.body.appendChild(f);
        const key = new FormData(f).keys().next().value;
        return Array.from(key).map((c) => c.charCodeAt(0));
      })()
    JS
    expect(key_codes).to eq([0x6E, 0xFFFD])   # "n" + U+FFFD
  end
end

# A submission whose target names a same-document frame runs JS-side. Its entry
# list is constructed once (firing `formdata`) and that SAME list is submitted, so
# a handler's append/delete reaches the request — and `formdata` fires exactly once
# (it used to fire a second time when the multipart path re-built the FormData).
RSpec.describe 'named-frame submit threads the constructed entry list' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/echo'
        [200, {'content-type' => 'text/html'}, ["<!doctype html><html><body>QS:#{env['QUERY_STRING']}</body></html>"]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <iframe name="resultframe"></iframe>
            <form id="f" action="/echo" method="get" target="resultframe">
              <input name="n1" value="v1">
            </form>
            <script>
              window.formdataFires = 0;
              document.getElementById('f').addEventListener('formdata', (e) => {
                window.formdataFires++;
                e.formData.append('extra', 'injected');
              });
            </script>
          </body></html>
        HTML
      end
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'fires formdata once and submits the handler-appended entry' do
    session.evaluate_script("document.getElementById('f').requestSubmit()")
    expect(session.evaluate_script('window.formdataFires')).to eq(1)
    session.within_frame('resultframe') do
      expect(session).to have_text('QS:n1=v1&extra=injected')
    end
  end
end

# The top-page submission path runs Ruby-side (the JS stashes the intent, the
# user-action drain navigates). A `formdata` handler's mutations must reach THAT
# submission too — the entry list JS constructed is threaded to Ruby rather than
# the form being re-serialised from the DOM.
RSpec.describe 'top-page submit threads the constructed entry list to Ruby' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/echo'
        [200, {'content-type' => 'text/html'}, ["<!doctype html><html><body>QS:#{env['QUERY_STRING']}</body></html>"]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <form id="f" action="/echo" method="get">
              <input name="n1" value="v1">
              <button type="submit">Go</button>
            </form>
            <script>
              document.getElementById('f').addEventListener('formdata', (e) => {
                e.formData.append('extra', 'injected');
                e.formData.delete('n1');
              });
            </script>
          </body></html>
        HTML
      end
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'submits the handler-mutated entry list (append + delete)' do
    session.click_button('Go')
    expect(session).to have_text('QS:extra=injected')
    expect(session).to have_current_path('/echo?extra=injected')
  end
end

# A form whose target names an iframe, submitted DURING PARSE by an inline
# script's `button.click()`, must navigate that iframe — not the top page. The
# element's handle isn't registered in the lookup table yet at parse time, so the
# named-frame path must serialise from the form OBJECT (not its handle); a handle
# miss there used to bail to a top-page navigation that destroyed the document
# (the WPT dirname / form-submission-target iframe tests hit exactly this).
RSpec.describe 'named-frame form submit during parse' do
  let(:app) {
    lambda do |env|
      if env['PATH_INFO'] == '/landing'
        [200, {'content-type' => 'text/html'}, ["<!doctype html><html><body>landing QS:#{env['QUERY_STRING']}</body></html>"]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><html><body>
            <form action="/landing" method="get" target="frame">
              <input name="q" value="self">
              <button type="submit">Go</button>
            </form>
            <iframe name="frame"></iframe>
            <script>document.querySelector('button').click();</script>
          </body></html>
        HTML
      end
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'navigates the named iframe, leaving the top page intact' do
    # Top page must NOT have navigated to the action URL.
    expect(session).to have_current_path('/')
    expect(session).to have_css('form')
    # The iframe received the GET submission.
    session.within_frame('frame') do
      expect(session).to have_text('landing QS:q=self')
    end
  end
end

# HTML "construct the entry list" step 5.1 skips a field that is DISABLED or has a
# `<datalist>` ancestor. "Disabled" means ACTUALLY disabled, so a `<fieldset disabled>`
# ancestor disables its controls too — except inside that fieldset's FIRST `<legend>`.
#
# WPT's constructor-formelement.html contains exactly this markup (`do-not-submit-me-2`
# in a datalist, `do-not-submit-me-6` in a disabled fieldset) but only asserts the
# `submit-me-*` entries are present — it never asserts the negative, so it passed while
# both were being submitted. These pin the skips directly.
RSpec.describe 'FormData entry-list skips (datalist / disabled fieldset)' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <form id="f">
            <datalist><input name="in-datalist" value="bad"></datalist>
            <fieldset disabled>
              <legend><input name="in-first-legend" value="ok"></legend>
              <input name="in-disabled-fieldset" value="bad">
              <select name="select-in-disabled-fieldset"><option value="bad" selected></option></select>
            </fieldset>
            <fieldset disabled>
              <legend></legend>
              <legend><input name="in-second-legend" value="bad"></legend>
            </fieldset>
            <fieldset>
              <input name="in-enabled-fieldset" value="ok">
            </fieldset>
            <input name="own-disabled" value="bad" disabled>
            <input name="plain" value="ok">
          </form>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  def entry_names
    session.evaluate_script(<<~JS)
      Array.from(new FormData(document.getElementById('f'))).map((e) => e[0])
    JS
  end

  it 'submits only the fields a real browser submits' do
    expect(entry_names).to eq(%w[in-first-legend in-enabled-fieldset plain])
  end

  it 'skips a control inside a <datalist>' do
    expect(entry_names).not_to include('in-datalist')
  end

  it 'skips a control disabled by a <fieldset disabled> ancestor' do
    expect(entry_names).not_to include('in-disabled-fieldset', 'select-in-disabled-fieldset')
  end

  it "exempts the disabled fieldset's first <legend>, but not a second one" do
    expect(entry_names).to include('in-first-legend')
    expect(entry_names).not_to include('in-second-legend')
  end
end

# HTML's select entry step: append an entry for each option whose selectedness is true
# AND that is not disabled. Which option is selected is settled by "ask for a reset" at
# parse/mutation time (auto-select the first NON-disabled option, only when size is 1
# and multiple is absent) — there is no submit-time fallback, so a select with nothing
# selected contributes nothing.
#
# Every expectation below was taken from headless Chrome, not from reading the spec.
# WPT's constructor-formelement.html has a `select-1` with disabled/selected options but
# never asserts it, so none of this was gate-visible.
RSpec.describe 'FormData select entries (disabled options / ask-for-a-reset)' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <form id="f">
            <select name="a-plain"><option value="a1"><option value="a2"></select>
            <select name="b-size4" size="4"><option value="b1"><option value="b2"></select>
            <select name="c-multi" multiple><option value="c1"><option value="c2"></select>
            <select name="d-firstdisabled"><option value="d1" disabled><option value="d2"></select>
            <select name="e-seldisabled"><option value="e1"><option value="e2" disabled selected></select>
            <select name="f-optgrp"><optgroup disabled><option value="f1" selected></optgroup></select>
            <select name="g-alldisabled"><option value="g1" disabled></select>
            <select name="h-size1" size="1"><option value="h1"><option value="h2"></select>
          </form>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  def entries
    session.evaluate_script('Array.from(new FormData(document.getElementById("f")))')
  end

  it 'submits exactly what Chrome submits' do
    expect(entries).to eq([%w[a-plain a1], %w[d-firstdisabled d2], %w[h-size1 h1]])
  end

  it 'skips a selected option that is disabled, or whose optgroup is' do
    expect(entries.map(&:first)).not_to include('e-seldisabled', 'f-optgrp')
  end

  it 'contributes nothing for a select with nothing selected (size > 1, multiple, all-disabled)' do
    expect(entries.map(&:first)).not_to include('b-size4', 'c-multi', 'g-alldisabled')
  end

  it 'auto-selects the first non-disabled option (ask for a reset), not merely the first' do
    expect(session.evaluate_script('document.getElementsByName("d-firstdisabled")[0].selectedIndex')).to eq(1)
    expect(session.evaluate_script('document.getElementsByName("b-size4")[0].selectedIndex')).to eq(-1)
  end
end

# An option's value is its `value` content attribute, or — when that is absent — its
# `text` IDL: the descendant text with <script> subtrees skipped and ASCII whitespace
# stripped and collapsed. Reading `textContent` instead submits the raw source text,
# which leaks an inline <script>'s source into the entry and turns pretty-printed
# markup into a value nobody typed. The IDL side lives in select_value_spec.rb.
#
# Every expectation below was taken from headless Chrome.
RSpec.describe 'FormData select entries (option value falls back to the collapsed text)' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><html><body>
          <form id="f">
            <select name="ws"><option>   Foo   Bar   </option></select>
            <select name="nl"><option>Foo
        Bar</option></select>
            <select name="hasval"><option value="  keep  ">   Foo   </option></select>
            <select name="scr"><option>A<script>var x = 1;</script>B</option></select>
            <select name="nested"><option><b> Foo </b> <i>Bar </i></option></select>
          </form>
        </body></html>
      HTML
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it 'submits the stripped-and-collapsed text, keeping a value attribute verbatim' do
    expect(session.evaluate_script('Array.from(new FormData(document.getElementById("f")))')).to eq([
      ['ws',     'Foo Bar'],
      ['nl',     'Foo Bar'],
      ['hasval', '  keep  '],
      ['scr',    'AB'],
      ['nested', 'Foo Bar']
    ])
  end
end

# FormData, generated from its IDL: its overloads told apart (a Blob's and a string's), its arguments converted
# (USVStrings), its pair iterator Web IDL's — and its entry list a slot, which a body and a submission encode as it is,
# whatever a page does to the iterator. The figures are headless Chrome's.
RSpec.describe 'FormData binding' do
  let(:app) {
    lambda do |env|
      if env['REQUEST_METHOD'] == 'POST'
        [200, {'content-type' => 'text/plain'}, [env['rack.input'].read]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><meta charset="utf-8">
          <form id="f" method="post" action="/echo"><input name="a" value="1"><button id="b" name="s" value="v">go</button></form>
        HTML
      end
    end
  }
  let(:session) { simulated_session(app) }
  before { session.visit '/' }

  it "throws Chrome's errors" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const error = (f) => { try { f(); return 'none'; } catch (e) { return e.message; } };
        return [
          error(() => new FormData().append('a', 'b', 'c')),
          error(() => new FormData(null)),
          error(() => new FormData(document.getElementById('f'), document.createElement('div'))),
          error(() => new FormData().append('a')),
          error(() => new FormData().entries().next.call(new Headers().entries()))
        ];
      })()
    JS
    expect(got).to eq([
      "Failed to execute 'append' on 'FormData': parameter 2 is not of type 'Blob'.",
      "Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.",
      "Failed to construct 'FormData': The specified element is not a submit button.",
      "Failed to execute 'append' on 'FormData': 2 arguments required, but only 1 present.",
      'Illegal invocation'
    ])
  end

  it 'makes its entries of a Blob a File and its strings scalar values' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const fd = new FormData(document.getElementById('f'), document.getElementById('b'));
        const file = new File(['x'], 'n.txt');
        fd.append('file', file);
        fd.append('blob', new Blob(['x']));
        fd.append('named', new Blob(['x']), 'z.bin');
        fd.append('a\\uD800', 'b\\uDC00');
        return [[...fd].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]), fd.get('file') === file,
                Object.prototype.toString.call(fd.entries()), FormData.length, FormData.prototype.append.length];
      })()
    JS
    expect(got).to eq([
      [%w[a 1], %w[s v], %w[file n.txt], %w[blob blob], %w[named z.bin], ["a\u{FFFD}", "b\u{FFFD}"]],
      true, '[object FormData Iterator]', 0, 2
    ])
  end

  it 'encodes its entry list as it is, whatever a page does to its iterator' do
    session.execute_script(<<~JS)
      FormData.prototype.forEach = FormData.prototype.entries = FormData.prototype[Symbol.iterator] = function () { return [][Symbol.iterator](); };
      const fd = new FormData();
      fd.append('k', 'v');
      fetch('/echo', {method: 'POST', body: fd}).then((r) => r.text()).then((t) => { window.got = t; });
    JS
    poll_until { session.evaluate_script('window.got') }
    expect(session.evaluate_script('window.got')).to include("name=\"k\"\r\n\r\nv\r\n")
    session.find(:css, '#b').click
    expect(session.text).to eq('a=1&s=v')
  end

  # (HTML "construct the entry list": a hidden `_charset_` field submits the encoding whatever its value; Chrome
  # 2026-10-10: UTF-8)
  it 'gives a hidden _charset_ control the encoding whatever its value' do
    result = session.evaluate_script(<<~JS)
      (function () {
        const f = document.createElement('form');
        f.innerHTML = '<input type=hidden name=_charset_ value=keep>';
        return [...new FormData(f)];
      })()
    JS
    expect(result).to eq([%w[_charset_ UTF-8]])
  end
end
