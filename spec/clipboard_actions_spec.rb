# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The clipboard's actions (Clipboard API §8), whichever of a script's `execCommand` and the user's Ctrl+X / C / V asks:
# the event, what a listener left in its data, and the rest of the action, as the engine plans them (editing_commands.rs
# `commandPlan`). Each figure was measured 2026-11-07 in headless Chrome and Firefox (real key events through CDP and
# WebDriver BiDi, a paste into a textarea reading the clipboard back); where they differ, or the spec overrules them, the
# example says.
RSpec.describe 'Clipboard actions' do
  page = <<~HTML
    <!DOCTYPE html><meta charset=utf-8>
    <button id=btn>b</button><textarea id=ta>hello world</textarea><textarea id=sink></textarea><textarea id=ro readonly>readonly text</textarea>
    <input id=inp value="input value"><input id=pw type=password value=secret><input id=num type=number value=123>
    <div id=h contenteditable><p id=hp>abc <b id=hb>def</b> ghi</p><p id=hq>jkl</p></div>
    <p id=plain>plain paragraph text</p>
    <script>
      window.log = [];
      const name = (t) => t.id || t.nodeName;
      for (const type of ['cut', 'copy', 'paste', 'beforeinput', 'input']) {
        document.addEventListener(type, (e) => {
          log.push(e.inputType === undefined ? `${type}@${name(e.target)}` : `${type}@${name(e.target)} ${e.inputType} ${e.data}`);
        }, true);
      }
      window.E = (id) => document.getElementById(id);
      window.sel = (n, a, m, b) => getSelection().setBaseAndExtent(n, a, m, b);
      window.selectPlain = () => {
        document.activeElement.blur();
        const t = E('plain').firstChild;
        sel(t, 0, t, 5);
      };
      window.selectHost = () => {
        E('h').focus();
        sel(E('hp').firstChild, 0, E('hb').firstChild, 3);
      };
      window.selectText = () => {
        E('ta').focus();
        E('ta').setSelectionRange(0, 5);
      };
    </script>
  HTML

  let(:session) do
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
  end

  def press(key)
    session.evaluate_script('document.activeElement').send_keys([:control, key])
  end

  def script(js)
    session.evaluate_script("(() => { #{js} })()")
  end

  def awaited(promise)
    session.evaluate_async_script("#{promise}.then(arguments[0])")
  end

  def plant_clipboard
    script("E('inp').focus(); E('inp').select();")
    press 'c'
    script("log.length = 0; getSelection().removeAllRanges(); document.activeElement.blur();")
  end

  # What the clipboard holds as text, read by pasting it.
  def clipboard_text
    script("E('sink').value = ''; E('sink').focus(); log.mute = log.length;")
    press 'v'
    session.evaluate_script("E('sink').value")
  end

  def events
    session.evaluate_script('log.slice(0, log.mute ?? log.length)')
  end

  before { plant_clipboard }

  describe 'as a script asks' do
    it "fires the copy event, whatever is selected, and copies what is" do
      expect(script("selectText(); return document.execCommand('copy')")).to be(true)
      expect(clipboard_text).to eq('hello')
      expect(events).to eq(['copy@ta'])
    end

    it 'leaves the clipboard as it was with nothing selected, at the body' do
      expect(script("return document.execCommand('copy')")).to be(true)
      expect(clipboard_text).to eq('input value')
      expect(events).to eq(['copy@BODY'])
    end

    it 'leaves the clipboard as it was at a caret in a text control' do
      expect(script("E('ta').focus(); E('ta').setSelectionRange(2, 2); return document.execCommand('copy')")).to be(true)
      expect(clipboard_text).to eq('input value')
    end

    it 'takes what a copy listener set, canceling it' do
      script("document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'HACK'); e.preventDefault(); }, {once: true});")
      expect(script("return document.execCommand('copy')")).to be(true)
      expect(clipboard_text).to eq('HACK')
    end

    it 'fires cut at the element holding the selection, input at the host' do
      expect(script("selectHost(); return document.execCommand('cut')")).to be(true)
      expect(events).to eq(['cut@hp', 'input@h deleteByCut null'])
      expect(clipboard_text).to eq('abc def')
      expect(session.evaluate_script("E('h').innerHTML")).to eq('<p id="hp">&nbsp;ghi</p><p id="hq">jkl</p>')
    end

    # (…false: §8.2 "if there is no selection or the context is not editable, return false", where Chrome answers true,
    # and Firefox for a caret)
    it 'cuts nothing with nothing to cut, its event fired all the same' do
      expect(script("selectPlain(); return document.execCommand('cut')")).to be(false)
      expect(events).to eq(['cut@plain'])
      script('log.length = 0;')
      expect(script("E('ta').focus(); E('ta').setSelectionRange(2, 2); return document.execCommand('cut')")).to be(false)
      expect(events).to eq(['cut@ta'])
      script('log.length = 0;')
      expect(script("E('h').focus(); sel(E('hq').firstChild, 1, E('hq').firstChild, 1); return document.execCommand('cut')")).to be(false)
      expect(events).to eq(['cut@hq'])
      expect(clipboard_text).to eq('input value')
    end

    it 'takes what a cut listener set, deleting nothing' do
      script("document.addEventListener('cut', (e) => { e.clipboardData.setData('text/plain', 'OVER'); e.preventDefault(); }, {once: true});")
      expect(script("selectText(); return document.execCommand('cut')")).to be(true)
      expect(session.evaluate_script("E('ta').value")).to eq('hello world')
      expect(events).to eq(['cut@ta'])
      expect(clipboard_text).to eq('OVER')
    end

    # (…the driver is configured to read the clipboard for a script, §5.3.3: Firefox's figures with its prefs; Chrome
    # refuses a page)
    it 'fires the paste event, and goes no further where it was canceled' do
      expect(script("selectText(); return document.execCommand('paste')")).to be(true)
      expect(events).to eq(['paste@ta', 'input@ta insertFromPaste input value'])
      expect(session.evaluate_script("E('ta').value")).to eq('input value world')
      script("log.length = 0; document.addEventListener('paste', (e) => e.preventDefault(), {once: true});")
      expect(script("return document.execCommand('paste')")).to be(false)
      expect(events).to eq(['paste@ta'])
    end

    it 'fires no beforeinput for any other command' do
      script("E('ta').focus(); E('ta').setSelectionRange(0, 0); document.execCommand('insertText', false, 'Z'); selectHost(); document.execCommand('bold');")
      expect(events).to eq(['input@ta insertText Z', 'input@h formatBold null'])
    end
  end

  describe 'as the user asks' do
    it 'writes what a copy listener set where it canceled, none where it did not' do
      script("selectText(); document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'OVER'); e.preventDefault(); }, {once: true});")
      press 'c'
      expect(clipboard_text).to eq('OVER')
      script("selectText(); document.addEventListener('copy', (e) => e.clipboardData.setData('text/plain', 'OVER'), {once: true});")
      press 'c'
      expect(clipboard_text).to eq('hello')
    end

    it 'leaves the clipboard as it was where a listener canceled and set nothing' do
      script("selectText(); document.addEventListener('copy', (e) => e.preventDefault(), {once: true});")
      press 'c'
      expect(clipboard_text).to eq('input value')
    end

    # (…the spec's "write content to the clipboard": cleared — where Chrome and Firefox leave it as it was)
    it 'clears the clipboard where a listener cleared the data and canceled' do
      script("selectText(); document.addEventListener('copy', (e) => { e.clipboardData.clearData(); e.preventDefault(); }, {once: true});")
      press 'c'
      expect(awaited('navigator.clipboard.read().then((items) => items.length)')).to eq(0)
    end

    # (…Chrome's custom data, a type of a page's own its paste event reads back; Firefox drops it)
    it "keeps a page's own type for a paste event, out of the asynchronous API" do
      script("selectText(); document.addEventListener('copy', (e) => { e.clipboardData.setData('application/x-trix', 'T'); e.preventDefault(); }, {once: true});")
      press 'c'
      script("document.addEventListener('paste', (e) => { window.pasted = [[...e.clipboardData.types], e.clipboardData.getData('application/x-trix'), e.clipboardData.files.length]; }, {once: true});")
      clipboard_text
      expect(session.evaluate_script('window.pasted')).to eq([['application/x-trix'], 'T', 0])
      expect(awaited('navigator.clipboard.read().then((items) => items.length)')).to eq(0)
    end

    it "gives a copy event read/write data its listeners may not keep" do
      script(<<~JS)
        selectText();
        document.addEventListener('copy', (e) => {
          const d = e.clipboardData;
          window.state = [d.types.length, d.items.length, d.dropEffect, d.effectAllowed, e.bubbles, e.cancelable, e.composed];
          d.setData('text/plain', 'X');
          window.state.push(d.getData('text/plain'));
          window.kept = d;
        }, {once: true});
      JS
      press 'c'
      expect(session.evaluate_script('window.state')).to eq([0, 0, 'none', 'uninitialized', true, true, true, 'X'])
      expect(session.evaluate_script('[window.kept.types.length, window.kept.getData("text/plain")]')).to eq([0, ''])
    end

    it 'gives a clipboard nothing of a password, however it is selected' do
      script("E('pw').focus(); E('pw').select();")
      press 'c'
      press 'x'
      expect(session.evaluate_script("E('pw').value")).to eq('secret')
      expect(clipboard_text).to eq('input value')
    end

    it 'copies and cuts what a number field holds' do
      script("E('num').focus(); E('num').select();")
      press 'x'
      expect(events).to eq(['cut@num', 'beforeinput@num deleteByCut null', 'input@num deleteByCut null'])
      expect(session.evaluate_script("E('num').value")).to eq('')
      expect(clipboard_text).to eq('123')
    end

    it 'fires the event of a non-editable cut and paste, and does nothing more' do
      script('selectPlain();')
      press 'x'
      press 'v'
      expect(events).to eq(['cut@plain', 'paste@plain'])
      expect(clipboard_text).to eq('input value')
    end

    it 'takes the cut of a read-only control or a caret as none' do
      script("E('ro').focus(); E('ro').setSelectionRange(0, 4);")
      press 'x'
      expect(events).to eq(['cut@ro'])
      script("log.length = 0; E('h').focus(); sel(E('hq').firstChild, 1, E('hq').firstChild, 1);")
      press 'x'
      expect(events).to eq(['cut@hq'])
      expect(clipboard_text).to eq('input value')
    end

    # (…the element holding the selection's start where anything is selected, as both engines have it, whatever is focused:
    # the spec's "focused node" is w3c/clipboard-apis#70, open)
    it 'fires at the element the selection starts in, else the body' do
      script("E('btn').focus(); selectPlain(); E('btn').focus();")
      press 'c'
      expect(events).to eq(['copy@plain'])
      expect(clipboard_text).to eq('plain')
      script("log.length = 0; log.mute = undefined; getSelection().removeAllRanges(); document.activeElement.blur();")
      press 'c'
      expect(events).to eq(['copy@BODY'])
    end

    it "copies the selection and cuts the focus a listener left" do
      script(<<~JS)
        selectPlain();
        document.addEventListener('copy', () => { const t = E('plain').firstChild; sel(t, 6, t, 15); }, {once: true});
      JS
      press 'c'
      expect(clipboard_text).to eq('paragraph')
      script(<<~JS)
        log.length = 0;
        log.mute = undefined;
        selectText();
        document.addEventListener('cut', () => { E('inp').focus(); E('inp').setSelectionRange(0, 5); }, {once: true});
      JS
      press 'x'
      expect(events).to eq(['cut@ta', 'beforeinput@inp deleteByCut null', 'input@inp deleteByCut null'])
      expect(session.evaluate_script("[E('ta').value, E('inp').value]")).to eq(['hello world', ' value'])
    end

    it 'writes the markup of the inline elements around what is copied' do
      script("E('h').focus(); const t = E('hb').firstChild; sel(t, 0, t, 2);")
      press 'c'
      expect(awaited("navigator.clipboard.read().then((items) => items[0].getType('text/html')).then((b) => b.text())")).to eq('<b id="hb">de</b>')
    end

    it 'keeps a cut canceled at its beforeinput on the clipboard, the page as it was' do
      script("selectHost(); document.addEventListener('beforeinput', (e) => e.preventDefault(), {once: true});")
      press 'x'
      expect(session.evaluate_script("E('h').firstChild.textContent")).to eq('abc def ghi')
      expect(clipboard_text).to eq('abc def')
    end

    # (…`data` none where the clipboard holds no text: Chrome; Firefox fires neither)
    it 'pastes no text from a clipboard of none' do
      script("selectText(); document.addEventListener('copy', (e) => { e.clipboardData.setData('text/x-foo', 'F'); e.preventDefault(); }, {once: true});")
      press 'c'
      script("log.length = 0; E('sink').value = ''; E('sink').focus();")
      press 'v'
      expect(events).to eq(['paste@sink', 'beforeinput@sink insertFromPaste null', 'input@sink insertFromPaste null'])
    end
  end

  # A paste into an editing host inserts the clipboard's markup, in the document's own terms: what runs or loads taken out,
  # as both engines take it — a frame out (Firefox; Chrome keeps it), a `<style>` kept (Firefox; Chrome inlines it) — a
  # block in a `<p>` the paragraph split around it (the Editing draft's "fix disallowed ancestors", Firefox: Chrome merges
  # the `<p>`s). A `plaintext-only` host takes the text.
  describe 'pasting markup' do
    def copy_markup(html)
      script(<<~JS)
        selectText();
        document.addEventListener('copy', (e) => {
          e.clipboardData.setData('text/plain', 'PLAIN');
          e.clipboardData.setData('text/html', #{html.to_json});
          e.preventDefault();
        }, {once: true});
      JS
      press 'c'
      script('log.length = 0;')
    end

    def paste_at_caret
      script("E('h').focus(); const t = E('hq').firstChild; sel(t, 1, t, 1);")
      press 'v'
      session.evaluate_script("E('h').lastElementChild.parentNode.innerHTML.replace(/^.*?<\\/p>/, '')")
    end

    it 'inserts it at the caret, its data in the event' do
      copy_markup('<b>x</b>y')
      expect(paste_at_caret).to eq('<p id="hq">j<b>x</b>ykl</p>')
      expect(events).to eq(['paste@hq', 'beforeinput@h insertFromPaste null', 'input@h insertFromPaste null'])
      expect(session.evaluate_script('getSelection().anchorNode.id + getSelection().anchorOffset')).to eq('hq3')
    end

    it 'takes out what runs, loads or says something of a document' do
      copy_markup(<<~HTML.delete("\n"))
        <div id="d" onclick="1" class="c"><script>window.ran = 1</script><a href="java\tscript:window.ran = 2" onmouseover="1" title="t">l</a>
        <img src="x" onerror="window.ran = 3"><iframe src="about:blank"></iframe><object data="x"></object><embed src="x"><meta name="a"><title>t</title>
        <base href="http://x/"><link rel="stylesheet" href="x"><form action="x"><button formaction="javascript:1">b</button></form><!--c--><style>b{}</style>t</div>
      HTML
      expect(paste_at_caret).to eq(<<~HTML.delete("\n"))
        <p id="hq">j</p><div id="d" class="c"><a title="t">l</a><img src="x"><form action="x"><button>b</button></form><style>b{}</style>t</div><p id="hq">kl</p>
      HTML
      expect(session.evaluate_script('window.ran')).to be_nil
    end

    it 'takes the fragment out of a whole document' do
      copy_markup('<html><head><meta charset=utf-8><title>tt</title></head><body><!--StartFragment--><i>x</i>y<!--EndFragment--></body></html>')
      expect(paste_at_caret).to eq('<p id="hq">j<i>x</i>ykl</p>')
    end

    it 'splits a paragraph around a block' do
      copy_markup('<p>one</p><p>two</p>')
      expect(paste_at_caret).to eq('<p id="hq">j</p><p>one</p><p>two</p><p id="hq">kl</p>')
      expect(session.evaluate_script('[getSelection().anchorNode.id, getSelection().anchorOffset]')).to eq(['h', 4])
    end

    it 'replaces what is selected, and an empty line' do
      copy_markup('<b>x</b>')
      script('selectHost();')
      press 'v'
      expect(session.evaluate_script("E('hp').innerHTML")).to eq('<b>x</b>&nbsp;ghi')
      script("E('hq').innerHTML = '<br>'; E('h').focus(); sel(E('hq'), 0, E('hq'), 0);")
      press 'v'
      expect(session.evaluate_script("E('hq').innerHTML")).to eq('<b>x</b>')
    end

    it 'gives a text control and a plaintext-only host its text' do
      copy_markup('<b>x</b>')
      expect(clipboard_text).to eq('PLAIN')
      script("log.mute = undefined; log.length = 0; E('h').setAttribute('contenteditable', 'plaintext-only'); E('h').focus(); const t = E('hq').firstChild; sel(t, 1, t, 1);")
      press 'v'
      expect(session.evaluate_script("E('hq').innerHTML")).to eq('jPLAINkl')
    end

    it 'leaves the page as it was where its beforeinput is canceled' do
      copy_markup('<b>x</b>')
      script("document.addEventListener('beforeinput', (e) => e.preventDefault(), {once: true});")
      expect(paste_at_caret).to eq('<p id="hq">jkl</p>')
    end
  end

  # What the selected number's `select()` selects (HTML's table: its row says yes), and the `input`-free read the rest of
  # this file's figures go by.
  it "selects a number field's text" do
    script("E('num').focus(); E('num').select(); ")
    press 'c'
    expect(clipboard_text).to eq('123')
  end
end
