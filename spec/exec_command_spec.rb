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
end
