# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `document.execCommand`'s editing commands in an editing host are the engine's edit (editing_commands.rs `editCommand`):
# a list toggled, retagged or wrapped; the selected text wrapped innermost (superscript and subscript exclusive), a link,
# a styled span; a block indented, outdented, aligned or its style cleared; a horizontal rule at the caret; the links
# the selection touches unwrapped — each the plain shape the driver has made of it (the Editing spec's styling
# algorithm is backlog), with the selection it leaves and the `input` it fires.
RSpec.describe 'execCommand in an editing host' do
  cases = [
    ['abcd', 't', 1, 3, ['bold']], ['abcd', 't', 1, 3, ['bold', 'italic']], ['ab<b>cd</b>ef', 'b', 0, 2, ['italic']],
    ['<p>one</p><p>two</p>', 'p0', 1, 1, ['insertOrderedList']], ['<ol><li>a</li></ol>', 'li', 0, 0, ['insertOrderedList']],
    ['<ol><li>a</li></ol>', 'li', 0, 0, ['insertUnorderedList']], ['abc', 't', 1, 1, ['insertUnorderedList']],
    ['<p>x</p>', 'p0', 0, 0, ['indent']], ['<p>x</p>', 'p0', 0, 0, ['indent', 'outdent']], ['abc', 't', 0, 0, ['indent']],
    ['abc', 't', 0, 3, ['createLink:http://x/']], ['<a href=#>abc</a>d', 'a', 1, 2, ['unlink']],
    ['abcd', 't', 1, 3, ['superscript', 'subscript']], ['abcd', 't', 1, 3, ['foreColor:red']], ['<p>abc</p>', 'p0', 1, 1, ['justifyCenter']],
    ['abc', 't', 1, 1, ['justifyRight']], ['<p style="color:red">abc</p>', 'p0', 1, 1, ['removeFormat']], ['abcd', 't', 2, 2, ['insertHorizontalRule']],
    ['abcd', 't', 1, 3, ['insertHorizontalRule']], ['<p>a</p><p>b</p>', 'p0', 0, 0, ['fontName:serif']]
  ]

  it 'edits as each command shapes it' do
    session = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><div id=e contenteditable></div>']]
    }).tap {|s| s.visit '/' }
    got = cases.map {|html, which, from, to, commands|
      session.evaluate_script(<<~JS)
        (() => {
          const e = document.getElementById('e');
          e.innerHTML = #{html.to_json};
          e.focus();
          const pick = {
            t: () => e.firstChild, b: () => e.querySelector('b').firstChild, p0: () => e.querySelector('p').firstChild,
            li: () => e.querySelector('li').firstChild, a: () => e.querySelector('a').firstChild
          }[#{which.to_json}]();
          getSelection().setBaseAndExtent(pick, #{from}, pick, #{to});
          const fired = [];
          e.addEventListener('input', (ev) => fired.push(ev.inputType + (ev.data ? '=' + ev.data : '')));
          for (const c of #{commands.to_json}) {
            const name = c.split(':')[0];
            document.execCommand(name, false, c.includes(':') ? c.slice(name.length + 1) : undefined);
          }
          const g = getSelection();
          const n = (x) => (x ? (x.nodeType === 3 ? JSON.stringify(x.data) : x.nodeName) : 'null');
          return [e.innerHTML, n(g.anchorNode) + '@' + g.anchorOffset + '-' + n(g.focusNode) + '@' + g.focusOffset, fired.join(',')];
        })()
      JS
    }
    expect(got).to eq([
      ['a<b>bc</b>d', 'DIV@1-DIV@2', 'formatBold'],
      ['a<b><i>bc</i></b>d', 'B@0-B@1', 'formatBold,formatItalic'],
      ['ab<b><i>cd</i></b>ef', 'B@0-B@1', 'formatItalic'],
      ['<ol><li>one</li></ol><p>two</p>', 'LI@1-LI@1', 'insertOrderedList'],
      ['a', 'DIV@1-DIV@1', 'insertOrderedList'],
      ['<ul><li>a</li></ul>', 'LI@0-LI@0', 'insertUnorderedList'],
      ['<ul><li>abc</li></ul>', 'LI@1-LI@1', 'insertUnorderedList'],
      ['<blockquote><p>x</p></blockquote>', 'DIV@1-DIV@1', 'formatIndent'],
      ['<p>x</p>', 'DIV@1-DIV@1', 'formatIndent,formatOutdent'],
      ['<blockquote>abc</blockquote>', 'DIV@0-DIV@0', 'formatIndent'],
      ['<a href="http://x/">abc</a>', 'DIV@0-DIV@1', 'insertLink=http://x/'],
      ['abcd', 'DIV@1-DIV@1', ''],
      ['a<sub>bc</sub>d', 'DIV@1-DIV@2', 'formatSuperscript,formatSubscript'],
      ['a<span style="color: red;">bc</span>d', 'DIV@1-DIV@2', 'formatFontColor=rgb(255, 0, 0)'],
      ['<p style="text-align: center;">abc</p>', '"abc"@1-"abc"@1', 'formatJustifyCenter'],
      ['<div style="text-align: right;">abc</div>', 'DIV@0-DIV@0', 'formatJustifyRight'],
      ['<p style="">abc</p>', '"abc"@1-"abc"@1', 'formatRemove'],
      ['ab<hr>cd', 'DIV@2-DIV@2', 'insertHorizontalRule'],
      ['a<hr>d', 'DIV@2-DIV@2', 'insertHorizontalRule'],
      ['<p>a</p><p>b</p>', '"a"@0-"a"@0', '']
    ])
  end

  # Where the selection is no place to put anything — inside a comment, across elements, out of the host, nowhere — and
  # what an observer hears of the edit (Chrome's shape, for each the reviewer measured there).
  edges = [
    ['abc<!--c-->def', 'getSelection().collapse(e.childNodes[1], 1)', 'insertHorizontalRule'],
    ['<b>abc</b><i>def</i>', 'getSelection().setBaseAndExtent(e.firstChild.firstChild, 1, e.lastChild.firstChild, 1)', 'insertHorizontalRule'],
    ['<p>abc</p><p>def</p>', 'getSelection().setBaseAndExtent(e.firstChild.firstChild, 1, e.lastChild.firstChild, 1)', 'insertHorizontalRule'],
    ['abc', 'getSelection().removeAllRanges()', 'insertHorizontalRule'],
    ['abc', 'getSelection().collapse(document, 1)', 'insertHorizontalRule'],
    ['abc', 'getSelection().setBaseAndExtent(out.firstChild, 1, out.firstChild, 2)', 'bold'],
    ['abc', 'getSelection().setBaseAndExtent(e.firstChild, 1, out.firstChild, 2)', 'bold'],
    ['abc', 'getSelection().setBaseAndExtent(e.firstChild, 0, e.firstChild, 3)', 'foreColor'],
    ['abc', 'getSelection().setBaseAndExtent(e.firstChild, 0, e.firstChild, 3)', 'createLink'],
    ['<ul><li>a</li></ul>', 'getSelection().collapse(e.querySelector("li").firstChild, 0)', 'insertOrderedList']
  ]

  it 'puts nothing where nothing goes, and tells an observer what it changed' do
    session = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><div id=e contenteditable></div><p id=out>out</p>']]
    }).tap {|s| s.visit '/' }
    got = edges.map {|html, setup, command|
      session.evaluate_script(<<~JS)
        (() => {
          const e = document.getElementById('e'), out = document.getElementById('out');
          e.innerHTML = #{html.to_json};
          e.focus();
          #{setup};
          const mo = new MutationObserver(() => {});
          mo.observe(document.body, {subtree: true, childList: true, attributes: true, characterData: true});
          const arg = {foreColor: 'red', createLink: '\\ud800z'}[#{command.to_json}];
          const ok = document.execCommand(#{command.to_json}, false, arg);
          const records = mo.takeRecords().map((r) =>
            r.type[0] + ':' + r.target.nodeName + '+' + r.addedNodes.length + '-' + r.removedNodes.length + (r.attributeName ? '@' + r.attributeName : ''));
          const a = e.querySelector('a');
          return [ok, e.innerHTML + (a && a.getAttribute('href') === '\\ud800z' ? ' (href exact)' : ''), out.innerHTML, records.join(' ')];
        })()
      JS
    }
    expect(got).to eq([
      [true, 'abc<!--c--><hr>def', 'out', 'c:DIV+1-0'],
      [true, '<b>a</b><hr><i>ef</i>', 'out', 'c:#text+0-0 c:#text+0-0 c:DIV+1-0'],
      [true, '<p>a</p><hr><p>ef</p>', 'out', 'c:#text+0-0 c:#text+0-0 c:DIV+1-0'],
      [false, 'abc', 'out', ''],
      [false, 'abc', 'out', ''],
      [false, 'abc', 'out', ''],
      [true, 'a<b>bc</b>', 'out', 'c:DIV+1-0 c:#text+0-0 c:DIV+1-0 c:DIV+0-1 c:B+1-0'],
      [true, '<span style="color: red;">abc</span>', 'out', 'c:DIV+1-0 c:DIV+0-1 c:SPAN+1-0'],
      [true, "<a href=\"\u{FFFD}z\">abc</a> (href exact)", 'out', 'c:DIV+1-0 c:DIV+0-1 c:A+1-0'],
      [true, '<ol><li>a</li></ol>', 'out', 'c:UL+0-1 c:DIV+1-1']
    ])
  end

  # The commands it carries out are the ones `queryCommandSupported` answers for — `paste` among them, the driver's
  # clipboard read, which Chrome refuses a page — and `queryCommandEnabled` with a selection in an editing host, or in a
  # text control the text ones only, none with none (Chrome's, but for `paste`).
  it 'answers which commands it supports and which the selection enables' do
    session = simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><div id=e contenteditable>hello</div><input id=t value=abc>']]
    }).tap {|s| s.visit '/' }
    got = session.evaluate_script(<<~JS)
      (() => {
        const names = ['bold', 'BOLD', 'insertText', 'delete', 'copy', 'paste', 'fontSize', 'selectAll', 'undo', 'bogus'];
        const which = (f) => names.filter((n) => f(n)).join(',');
        const out = [which((n) => document.queryCommandSupported(n)), which((n) => document.queryCommandEnabled(n))];
        e.focus();
        getSelection().selectAllChildren(e);
        out.push(which((n) => document.queryCommandEnabled(n)));
        getSelection().removeAllRanges();
        t.focus();
        t.select();
        out.push(which((n) => document.queryCommandEnabled(n)));
        return out;
      })()
    JS
    expect(got).to eq(['bold,BOLD,insertText,delete,copy,paste', '', 'bold,BOLD,insertText,delete,copy,paste', 'insertText,delete,copy,paste'])
  end

  # A colour or a font the style attribute refuses styles nothing: no span, the `input` alone — the selection's DOM as
  # it was (Chrome: true, `hi`). A quirks document parses the colour in its mode: a hashless hex is one there.
  it "makes no span of a value that styles nothing, and takes a quirks document's hashless colour" do
    pick = lambda {|doctype|
      session = simulated_session(lambda {|_env|
        [200, {'content-type' => 'text/html'}, ["#{doctype}<meta charset=utf-8><div id=e contenteditable>hi</div>"]]
      }).tap {|s| s.visit '/' }
      session.evaluate_script(<<~JS)
        (() => {
          const e = document.getElementById('e'), got = [];
          e.addEventListener('input', (ev) => got.push(ev.data));
          for (const [command, value] of [['foreColor', 'not a color'], ['fontName', 'a;color:red'], ['foreColor', 'ff0000']]) {
            e.innerHTML = 'hi';
            e.focus();
            getSelection().selectAllChildren(e);
            got.push(String(document.execCommand(command, false, value)), e.innerHTML);
          }
          return got;
        })()
      JS
    }
    expect(pick.call('<!DOCTYPE html>')).to eq(['not a color', 'true', 'hi', 'a;color:red', 'true', 'hi', 'ff0000', 'true', 'hi'])
    expect(pick.call('').last(2)).to eq(['true', '<span style="color: rgb(255, 0, 0);">hi</span>'])
  end
end
