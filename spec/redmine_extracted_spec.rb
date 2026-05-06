require 'capybara/simulated'
require 'rack'

# Unit-level coverage for the surface added during the Redmine
# debugging push: clipboard shortcuts, Range partial cloning, form
# named-element access, submitter handling under `data-disable-with`,
# `option.selected` IDL semantics, send_keys `:enter` →
# `beforeinput`, and friends. Each behaviour is exercised against a
# small fixture so a regression surfaces here rather than in the
# downstream Redmine system suite.
RSpec.describe 'Redmine-extracted browser surface' do
  def make_session(html)
    app = lambda do |env|
      body = case env['PATH_INFO']
             when '/post'
               # Echo the raw POST body (or query string for GET) so specs
               # can grep `session.body` directly. Avoids Rack::Request#params'
               # last-wins flattening on repeated keys (`cols=a&cols=b`).
               raw = env['rack.input']&.read || ''
               raw.empty? ? env['QUERY_STRING'].to_s : raw
             else
               html
             end
      [200, {'content-type' => 'text/html; charset=utf-8'}, [body]]
    end
    Capybara::Session.new(:simulated, app)
  end

  describe 'Range#cloneContents' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <div id="src"><p id="p">Unable to print recipes</p></div>
          <div id="multi">
            <p>first paragraph</p>
            <span class="meta">[meta]</span>
            <p>second paragraph</p>
          </div>
          <div id="cross"><p>before</p><span>middle</span><p>tail-text</p></div>
        </body></html>
      HTML
    }

    it 'clones a substring of a single text node' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const t = document.querySelector('#p').childNodes[0];
        const r = document.createRange();
        r.setStart(t, 10);
        r.setEnd(t, 15);
        const div = document.createElement('div');
        div.appendChild(r.cloneContents());
        div.textContent
      JS
      expect(result).to eq('print')
    end

    it 'clones a slice of element children when both boundaries land on the same parent' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const parent = document.querySelector('#multi');
        const r = document.createRange();
        r.setStart(parent, 0);
        r.setEnd(parent, 2);
        const div = document.createElement('div');
        div.appendChild(r.cloneContents());
        div.textContent
      JS
      expect(result).to include('first paragraph')
    end

    it 'spans cross-boundary ranges with partial start / end' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const root = document.querySelector('#cross');
        const r = document.createRange();
        r.setStartBefore(root.querySelector('span'));
        r.setEnd(root.children[2].childNodes[0], 4);  // "tail" out of "tail-text"
        const div = document.createElement('div');
        div.appendChild(r.cloneContents());
        div.textContent
      JS
      expect(result).to include('middle')
      expect(result).to include('tail')
      expect(result).not_to include('tail-text')
    end

    it 'computes commonAncestorContainer from start and end boundary paths' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const root = document.querySelector('#cross');
        const r = document.createRange();
        r.setStartBefore(root.querySelector('span'));
        r.setEndAfter(root.children[2]);
        r.commonAncestorContainer.id
      JS
      expect(result).to eq('cross')
    end

    it 'reports a text node as nodeName "#text"' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        document.querySelector('#p').childNodes[0].nodeName
      JS
      expect(result).to eq('#text')
    end

    it 'exposes CharacterData.data and nodeValue on text nodes only' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const t = document.querySelector('#p').childNodes[0];
        const e = document.querySelector('#p');
        ({
          text_data:    t.data,
          text_nodeval: t.nodeValue,
          elem_data:    e.data,
          elem_nodeval: e.nodeValue
        })
      JS
      expect(result['text_data']).to eq('Unable to print recipes')
      expect(result['text_nodeval']).to eq('Unable to print recipes')
      # Element nodes return undefined / null for these CharacterData
      # accessors. QuickJS marshals JS undefined as the :undefined symbol.
      expect(result['elem_data']).to    eq(:undefined)
      expect(result['elem_nodeval']).to be_nil
    end
  end

  describe 'Selection.containsNode + intersectsNode' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <p id="a">Alpha</p>
          <p id="b">Bravo</p>
        </body></html>
      HTML
    }

    it 'reports false when no range is added' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        window.getSelection().containsNode(document.querySelector('#a'), true)
      JS
      expect(result).to be false
    end

    it 'returns true when a range intersects the queried node' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const r = document.createRange();
        r.selectNodeContents(document.querySelector('#a'));
        window.getSelection().addRange(r);
        ({
          contains_a: window.getSelection().containsNode(document.querySelector('#a'), true),
          contains_b: window.getSelection().containsNode(document.querySelector('#b'), true)
        })
      JS
      expect(result['contains_a']).to be true
      expect(result['contains_b']).to be false
    end
  end

  describe 'Element#setRangeText' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <textarea id="ta">hello world</textarea>
        </body></html>
      HTML
    }

    it 'replaces text within the given range' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const ta = document.querySelector('#ta');
        ta.setRangeText('Earth', 6, 11, 'end');
        ({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd })
      JS
      expect(result['value']).to eq('hello Earth')
      expect(result['selStart']).to eq(11)
      expect(result['selEnd']).to eq(11)
    end

    it 'with selectionMode "select" leaves the inserted text selected' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const ta = document.querySelector('#ta');
        ta.setRangeText('foo', 0, 5, 'select');
        ({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd })
      JS
      expect(result['value']).to eq('foo world')
      expect(result['selStart']).to eq(0)
      expect(result['selEnd']).to eq(3)
    end
  end

  describe 'send_keys' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <textarea id="ta"></textarea>
          <pre id="log"></pre>
          <script>
            const log = document.querySelector('#log');
            const ta  = document.querySelector('#ta');
            for (const t of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input']) {
              ta.addEventListener(t, e => {
                log.textContent += t + ':' + (e.key || '') + '|' + (e.inputType || '') + '\\n';
              });
            }
          </script>
        </body></html>
      HTML
    }

    it 'fires keydown / keypress / keyup per typed character' do
      session = make_session(html)
      session.visit '/'
      session.find('#ta').send_keys('ab')
      log = session.find('#log').text
      expect(log.scan('keydown:a').length).to  eq(1)
      expect(log.scan('keydown:b').length).to  eq(1)
      expect(log.scan('keypress:a').length).to eq(1)
      expect(log.scan('keyup:b').length).to    eq(1)
    end

    it 'fires beforeinput with inputType=insertLineBreak on :enter' do
      session = make_session(html)
      session.visit '/'
      session.find('#ta').send_keys('hi', :enter, 'next')
      log = session.find('#log').text
      expect(log).to include('beforeinput:|insertLineBreak')
      expect(session.find('#ta').value).to eq("hi\nnext")
    end

    it 'lets a beforeinput listener preventDefault and replace the default newline' do
      session = make_session(html)
      session.visit '/'
      session.execute_script(<<~JS)
        document.querySelector('#ta').addEventListener('beforeinput', e => {
          if (e.inputType !== 'insertLineBreak') return;
          e.preventDefault();
          const ta = e.currentTarget;
          ta.setRangeText('***', ta.selectionStart, ta.selectionEnd, 'end');
        });
      JS
      session.find('#ta').send_keys('hi', :enter)
      expect(session.find('#ta').value).to eq('hi***')
    end

    it 'carries modifier flags + KeyboardEvent.key on chord-array inputs' do
      session = make_session(html)
      session.visit '/'
      session.execute_script(<<~JS)
        window.__caught = [];
        document.querySelector('#ta').addEventListener('keydown', e => {
          window.__caught.push([e.key, e.ctrlKey, e.shiftKey]);
        });
      JS
      session.find('#ta').send_keys([:control, 'b'])
      caught = session.evaluate_script('window.__caught')
      # Two keydowns: Control press, then 'b' with ctrlKey set.
      ctrl_b = caught.find { |key, ctrl, _| key == 'b' && ctrl }
      expect(ctrl_b).not_to be_nil
    end

    it 'Ctrl+B does not insert the literal "b"' do
      session = make_session(html)
      session.visit '/'
      session.find('#ta').send_keys([:control, 'b'])
      expect(session.find('#ta').value).to eq('')
    end
  end

  describe 'clipboard shortcuts (Ctrl+V / Ctrl+C / Ctrl+X)' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <textarea id="ta">hello</textarea>
        </body></html>
      HTML
    }

    it 'navigator.clipboard round-trips writeText / readText' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_async_script(<<~JS)
        const cb = arguments[0];
        navigator.clipboard.writeText('round-trip').then(() =>
          navigator.clipboard.readText().then(cb)
        );
      JS
      expect(result).to eq('round-trip')
    end

    it 'Ctrl+V pastes the clipboard text at the caret' do
      session = make_session(html)
      session.visit '/'
      session.execute_script("navigator.clipboard.writeText(' world')")
      ta = session.find('#ta')
      ta.send_keys(:end, [:control, 'v'])
      expect(ta.value).to eq('hello world')
    end

    it 'Ctrl+C copies the field value to the clipboard' do
      session = make_session(html)
      session.visit '/'
      session.find('#ta').send_keys([:control, 'c'])
      result = session.evaluate_async_script(<<~JS)
        navigator.clipboard.readText().then(arguments[0]);
      JS
      expect(result).to eq('hello')
    end

    it 'Ctrl+X copies and clears the field' do
      session = make_session(html)
      session.visit '/'
      session.find('#ta').send_keys([:control, 'x'])
      expect(session.find('#ta').value).to eq('')
      result = session.evaluate_async_script('navigator.clipboard.readText().then(arguments[0])')
      expect(result).to eq('hello')
    end
  end

  describe 'option.selected IDL' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <select id="s">
            <option value="1" selected>One</option>
            <option value="2">Two</option>
            <option value="3">Three</option>
          </select>
          <select id="m" multiple>
            <option value="a">A</option>
            <option value="b">B</option>
          </select>
        </body></html>
      HTML
    }

    it 'assigning selected=true on a single-select clears the previous selection' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const s = document.querySelector('#s');
        s.options[1].selected = true;
        ({
          one_attr: s.options[0].getAttribute('selected'),
          two_attr: s.options[1].getAttribute('selected'),
          two_prop: s.options[1].selected,
          one_prop: s.options[0].selected,
          select_value: s.value
        })
      JS
      expect(result['one_attr']).to be_nil
      expect(result['two_attr']).to eq('selected')
      expect(result['two_prop']).to be true
      expect(result['one_prop']).to be false
      expect(result['select_value']).to eq('2')
    end

    it 'writes the literal "selected" attribute value (Redmine option[selected=selected] pattern)' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const m = document.querySelector('#m');
        m.options[0].selected = true;
        m.querySelectorAll('option[selected=selected]').length
      JS
      expect(result).to eq(1)
    end

    it 'multi-select keeps prior selections additive' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const m = document.querySelector('#m');
        m.options[0].selected = true;
        m.options[1].selected = true;
        [...m.options].map(o => o.selected)
      JS
      expect(result).to eq([true, true])
    end

    it 'select.selectedIndex reads and writes through one round-trip' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const s = document.querySelector('#s');
        const before = s.selectedIndex;
        s.selectedIndex = 2;
        ({ before, after: s.selectedIndex, value: s.value })
      JS
      expect(result['before']).to eq(0)
      expect(result['after']).to eq(2)
      expect(result['value']).to eq('3')
    end

    it 'select.type returns "select-one" / "select-multiple" per the IDL' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        ({
          one:  document.querySelector('#s').type,
          many: document.querySelector('#m').type
        })
      JS
      expect(result['one']).to  eq('select-one')
      expect(result['many']).to eq('select-multiple')
    end

    it 'select.multiple reflects the "multiple" attribute' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        ({
          single: document.querySelector('#s').multiple,
          multi:  document.querySelector('#m').multiple
        })
      JS
      expect(result['single']).to be false
      expect(result['multi']).to  be true
    end
  end

  describe 'form named-element access' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <form id="f">
            <input name="alpha" id="alpha-input" value="A">
            <input name="beta"  id="beta-input"  value="B">
            <button id="btn" type="button">go</button>
          </form>
        </body></html>
      HTML
    }

    it 'supports form.elements[name] and namedItem' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const f = document.querySelector('#f');
        ({
          via_brackets: f.elements['alpha']?.value,
          via_named:    f.elements.namedItem('beta')?.value,
          numeric:      f.elements[0]?.id
        })
      JS
      expect(result['via_brackets']).to eq('A')
      expect(result['via_named']).to    eq('B')
      expect(result['numeric']).to      eq('alpha-input')
    end

    it 'supports form.<name> property access via the element-getter Proxy' do
      session = make_session(html)
      session.visit '/'
      # Reach the form through `someControl.form` — that's the path
      # Redmine's inline `onclick` handlers (`this.form.X`) take and
      # the only one our Proxy wraps. A bare `document.querySelector`
      # returns the unwrapped Element on purpose.
      result = session.evaluate_script(<<~JS)
        const f = document.querySelector('#alpha-input').form;
        ({
          by_name: f.alpha && f.alpha.value,
          by_id:   f['beta-input'] && f['beta-input'].value
        })
      JS
      expect(result['by_name']).to eq('A')
      expect(result['by_id']).to   eq('B')
    end

    it 'returns the same proxy on repeated form-getter access (button.form === button.form)' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script("(() => { const b = document.querySelector('#btn'); return b.form === b.form; })()")
      expect(result).to be true
    end

    it 'real Element members (id, tagName) shadow named-element lookups' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const f = document.querySelector('#f');
        ({ id: f.id, tag: f.tagName })
      JS
      expect(result['id']).to  eq('f')
      expect(result['tag']).to eq('FORM')
    end
  end

  describe 'form submission' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <form id="f" action="/post" method="post">
            <input name="x" value="1">
            <input id="commit"   type="submit" name="commit"   value="Save">
            <input id="continue" type="submit" name="continue" value="Save and continue">
          </form>
          <pre id="log"></pre>
        </body></html>
      HTML
    }

    it 'sends the submitter button name=value with the form body' do
      session = make_session(html)
      session.visit '/'
      session.find('#continue').click
      expect(session.body).to include('continue=Save+and+continue')
      expect(session.body).not_to include('commit=Save')
    end

    it 'preserves the submitter when a listener disables the button mid-dispatch (data-disable-with)' do
      session = make_session(html)
      session.visit '/'
      session.execute_script(<<~JS)
        document.querySelector('#f').addEventListener('submit', () => {
          document.querySelector('#commit').disabled = true;
        });
      JS
      session.find('#commit').click
      expect(session.body).to include('commit=Save')
    end

    it 'lets a submit listener mutate the form before serialization (dual-listbox prop("selected", true))' do
      html_with_select = <<~HTML
        <!doctype html><html><body>
          <form id="f" action="/post" method="post">
            <select name="cols" multiple id="sel">
              <option value="a">A</option>
              <option value="b">B</option>
              <option value="c">C</option>
            </select>
            <input id="save" type="submit" name="commit" value="Save">
          </form>
          <script>
            document.querySelector('#f').addEventListener('submit', () => {
              document.querySelectorAll('#sel option').forEach(o => o.selected = true);
            });
          </script>
        </body></html>
      HTML
      session = make_session(html_with_select)
      session.visit '/'
      session.find('#save').click
      expect(session.body).to include('cols=a')
      expect(session.body).to include('cols=b')
      expect(session.body).to include('cols=c')
    end
  end

  describe 'attach_file' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <form id="f" action="/post" method="post" enctype="multipart/form-data">
            <input type="file" name="upload" id="upload">
            <input type="submit" value="Send">
          </form>
        </body></html>
      HTML
    }

    it 'silently drops a follow-up empty-string write (Redmine attachments.js dummy reset)' do
      file = '/tmp/csim-attach-test.txt'
      File.write(file, 'sample-content')
      session = make_session(html)
      session.visit '/'
      session.attach_file('upload', file)
      # Mimic Redmine's `dummy.value = ''` after cloning the picker.
      session.execute_script("document.querySelector('#upload').value = ''")
      # The submit must not raise on the now-empty pick.
      expect { session.find('input[type=submit]').click }.not_to raise_error
    ensure
      File.delete(file) if File.exist?(file)
    end
  end

  describe ':scope CSS selector handling' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <ul id="root"><li>1</li><li>2</li><li>3</li></ul>
        </body></html>
      HTML
    }

    it 'querySelectorAll(":scope > *") works (jQuery 3 / Sizzle relative selectors)' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script("document.querySelector('#root').querySelectorAll(':scope > *').length")
      expect(result).to eq(3)
    end
  end

  describe 'Browser#hover' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <div id="a">A</div>
          <div id="b">B</div>
          <pre id="log"></pre>
          <script>
            const log = document.querySelector('#log');
            for (const id of ['a', 'b']) {
              for (const t of ['mouseover', 'mouseenter', 'mouseout', 'mouseleave', 'mousemove']) {
                document.querySelector('#' + id).addEventListener(t, e => {
                  log.textContent += id + ':' + t + '\\n';
                });
              }
            }
          </script>
        </body></html>
      HTML
    }

    it 'fires mouseover / mouseenter / mousemove on the target' do
      session = make_session(html)
      session.visit '/'
      session.find('#a').hover
      log = session.find('#log').text
      expect(log).to include('a:mouseover')
      expect(log).to include('a:mouseenter')
      expect(log).to include('a:mousemove')
    end

    it 'fires mouseout / mouseleave on the previously-hovered element when moving' do
      session = make_session(html)
      session.visit '/'
      session.find('#a').hover
      session.find('#b').hover
      log = session.find('#log').text
      expect(log).to include('a:mouseout')
      expect(log).to include('a:mouseleave')
      expect(log).to include('b:mouseenter')
    end

    it 're-hovering the same element is a no-op' do
      session = make_session(html)
      session.visit '/'
      session.find('#a').hover
      session.execute_script("document.querySelector('#log').textContent = '';")
      session.find('#a').hover
      expect(session.find('#log').text).to eq('')
    end
  end

  describe 'click pre-toggle on checkbox / radio' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <input type="checkbox" id="cb">
          <pre id="log"></pre>
          <script>
            document.querySelector('#cb').addEventListener('click', e => {
              document.querySelector('#log').textContent = String(e.target.checked);
            });
          </script>
        </body></html>
      HTML
    }

    it 'click handlers see the post-toggle checked state' do
      session = make_session(html)
      session.visit '/'
      session.find('#cb').click
      expect(session.find('#log').text).to eq('true')
    end

    it 'reverts the toggle if a listener calls preventDefault' do
      session = make_session(html)
      session.visit '/'
      session.execute_script(<<~JS)
        document.querySelector('#cb').addEventListener('click', e => e.preventDefault());
      JS
      session.find('#cb').click
      expect(session.evaluate_script("document.querySelector('#cb').checked")).to be false
    end
  end

  describe 'MouseEvent.which' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <button id="b">click</button>
          <pre id="log"></pre>
          <script>
            const log = document.querySelector('#log');
            document.querySelector('#b').addEventListener('click',       e => log.textContent += 'click:' + e.which + '\\n');
            document.querySelector('#b').addEventListener('contextmenu', e => log.textContent += 'ctx:'   + e.which + '\\n');
          </script>
        </body></html>
      HTML
    }

    it 'click sends event.which = 1 (left button, 1-indexed)' do
      session = make_session(html)
      session.visit '/'
      session.find('#b').click
      expect(session.find('#log').text).to include('click:1')
    end

    it 'right_click sends event.which = 3' do
      session = make_session(html)
      session.visit '/'
      session.find('#b').right_click
      expect(session.find('#log').text).to include('ctx:3')
    end
  end

  describe 'window.event during dispatch' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <input id="i" type="text">
          <pre id="log"></pre>
          <script>
            document.querySelector('#i').addEventListener('input', () => {
              // IE-era idiom — read the global instead of taking the
              // event as a parameter. Redmine's Tribute config does this.
              document.querySelector('#log').textContent = window.event && window.event.target && window.event.target.id;
            });
          </script>
        </body></html>
      HTML
    }

    it 'is set to the in-flight event so legacy handlers can read it' do
      session = make_session(html)
      session.visit '/'
      session.fill_in 'i', with: 'x'
      expect(session.find('#log').text).to eq('i')
    end

    it 'is cleared after dispatch returns' do
      session = make_session(html)
      session.visit '/'
      session.fill_in 'i', with: 'x'
      expect(session.evaluate_script('typeof window.event')).to eq('undefined')
    end
  end

  describe 'DOMTokenList.replace' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <div id="d" class="foo bar baz"></div>
        </body></html>
      HTML
    }

    it 'swaps a token in place' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const d = document.querySelector('#d');
        const out = d.classList.replace('bar', 'qux');
        ({ result: out, classes: d.className })
      JS
      expect(result['result']).to be true
      expect(result['classes']).to eq('foo qux baz')
    end

    it 'returns false and does not mutate when the old token is missing' do
      session = make_session(html)
      session.visit '/'
      result = session.evaluate_script(<<~JS)
        const d = document.querySelector('#d');
        const out = d.classList.replace('missing', 'qux');
        ({ result: out, classes: d.className })
      JS
      expect(result['result']).to be false
      expect(result['classes']).to eq('foo bar baz')
    end
  end

  describe 'focus / focusin' do
    let(:html) {
      <<~HTML
        <!doctype html><html><body>
          <input id="i">
          <pre id="log"></pre>
          <script>
            const log = document.querySelector('#log');
            // jQuery 3 rewrites delegated `focus` listeners to focusin
            // — so the bridge must dispatch focusin alongside focus.
            for (const t of ['focus', 'focusin', 'blur', 'focusout']) {
              document.addEventListener(t, e => log.textContent += t + ':' + e.target.id + '\\n', true);
            }
          </script>
        </body></html>
      HTML
    }

    it 'fires both focus (capture) and focusin (bubbling) on focus' do
      session = make_session(html)
      session.visit '/'
      session.find('#i').click
      log = session.find('#log').text
      expect(log).to include('focus:i')
      expect(log).to include('focusin:i')
    end
  end
end
