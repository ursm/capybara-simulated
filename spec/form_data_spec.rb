require 'capybara/simulated'

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
  let(:session) { Capybara::Session.new(:simulated, app) }

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

  it 'falls back to textContent when the value attribute is missing' do
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
  let(:session) { Capybara::Session.new(:simulated, app) }
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
  let(:session) { Capybara::Session.new(:simulated, app) }
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
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  it 'submits the handler-mutated entry list (append + delete)' do
    session.click_button('Go')
    expect(session).to have_text('QS:extra=injected')
    expect(session).to have_current_path('/echo?extra=injected')
  end
end
