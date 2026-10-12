# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Typing, Enter and Shift+Enter in an editing host are the engine's (editing_insert.rs): text at the caret — the
# placeholder `<br>` of an empty line giving way to it — the white space it brings together rebalanced as the line shows
# it, a `<br>` (a second where it ends its block), and the caret's block split in two. Every expectation is Chrome's.
RSpec.describe 'inserting in an editing host' do
  let(:session) {
    simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><div id=e contenteditable style="width:300px;font:16px monospace"></div>']]
    }).tap {|s| s.visit '/' }
  }

  # …the innerHTML the keys leave, and where the caret is — the caret first at the node `at` (a script expression over
  # `e`, the host) and `offset`.
  def typed(html, at, offset, *keys)
    session.execute_script(<<~JS)
      const e = document.getElementById('e');
      e.innerHTML = #{html.to_json};
      e.focus();
      getSelection().collapse(#{at}, #{offset});
    JS
    keys.each {|key| session.find(:css, '#e').send_keys(key) }
    session.evaluate_script(<<~JS)
      (() => {
        const g = getSelection(), n = g.focusNode;
        return [document.getElementById('e').innerHTML, (n.nodeType === 3 ? n.data : n.nodeName) + '@' + g.focusOffset];
      })()
    JS
  end

  it 'types text where the line shows it, into the empty line a placeholder holds' do
    expect([
      typed('<p><br></p>', 'e.firstChild', 0, 'x'),
      typed('<p><b><br></b></p>', "e.querySelector('b')", 0, 'x'),
      typed('ab<br>', 'e', 2, 'x'),
      typed('abcd', 'e.firstChild', 1, %i[shift right], %i[shift right], 'x'),
      typed('<p>aa</p><p>bb</p>', 'e.firstChild.firstChild', 1, %i[shift down], 'x')
    ]).to eq([
      %w[<p>x</p> x@1], %w[<p><b>x</b></p> x@1], %w[abx<br> abx@3], %w[axd axd@2], %w[<p>axb</p> axb@2]
    ])
  end

  it 'rebalances the white space typed as the line shows it' do
    spaces = ->(html, at, offset, key) { typed(html, at, offset, key).first }
    expect([
      spaces.call('ab', 'e.firstChild', 2, :space),
      spaces.call('ab', 'e.firstChild', 1, :space),
      spaces.call('ab', 'e.firstChild', 0, :space),
      spaces.call('a b', 'e.firstChild', 1, :space),
      spaces.call('a&nbsp; b', 'e.firstChild', 2, 'x'),
      spaces.call('ab&nbsp;&nbsp;', 'e.firstChild', 4, 'c'),
      spaces.call('<p><br></p>', 'e.firstChild', 0, :space),
      spaces.call('<pre>ab</pre>', 'e.firstChild.firstChild', 2, :space)
    ]).to eq(['ab&nbsp;', 'a b', '&nbsp;ab', 'a&nbsp; b', 'a x b', 'ab&nbsp; c', '<p>&nbsp;</p>', '<pre>ab </pre>'])
  end

  it 'breaks a line, a second `<br>` where it ends its block' do
    expect([
      typed('abcd', 'e.firstChild', 2, %i[shift enter]),
      typed('abcd', 'e.firstChild', 4, %i[shift enter]),
      typed('<p>abcd</p>', 'e.firstChild.firstChild', 4, %i[shift enter]),
      typed('<p>ab cd</p>', 'e.firstChild.firstChild', 2, %i[shift enter]),
      typed('<pre>ab</pre>', 'e.firstChild.firstChild', 1, :enter),
      typed('<table><tbody><tr><td>ab</td></tr></tbody></table>', "e.querySelector('td').firstChild", 1, :enter).first
    ]).to eq([
      ['ab<br>cd', 'cd@0'], ['abcd<br><br>', 'DIV@2'], ['<p>abcd<br><br></p>', 'P@2'], ['<p>ab<br>&nbsp;cd</p>', "\u00A0cd@0"],
      ['<pre>a<br>b</pre>', 'b@0'], '<table><tbody><tr><td>a<br>b</td></tr></tbody></table>'
    ])
  end

  it 'splits the block at the caret, the inline elements around it too, attributes and all' do
    expect([
      typed('<p>abcd</p>', 'e.firstChild.firstChild', 2, :enter),
      typed('<p>abcd</p>', 'e.firstChild.firstChild', 4, :enter),
      typed('<p>abcd</p>', 'e.firstChild.firstChild', 0, :enter),
      typed('<p><b>abcd</b></p>', "e.querySelector('b').firstChild", 2, :enter),
      typed('<p><b>abcd</b></p>', "e.querySelector('b').firstChild", 4, :enter),
      typed('<p id="x" class="y">abcd</p>', 'e.firstChild.firstChild', 2, :enter).first,
      typed('<h1>ab</h1>', 'e.firstChild.firstChild', 2, :enter),
      typed('<h1>ab</h1>', 'e.firstChild.firstChild', 1, :enter).first,
      typed('<p>ab cd</p>', 'e.firstChild.firstChild', 3, :enter).first,
      typed('<p>aa</p><p>bb</p>', 'e.firstChild.firstChild', 1, %i[shift down], :enter)
    ]).to eq([
      ['<p>ab</p><p>cd</p>', 'cd@0'], ['<p>abcd</p><p><br></p>', 'P@0'], ['<p><br></p><p>abcd</p>', 'abcd@0'],
      ['<p><b>ab</b></p><p><b>cd</b></p>', 'cd@0'], ['<p><b>abcd</b></p><p><b><br></b></p>', 'B@0'],
      '<p id="x" class="y">ab</p><p id="x" class="y">cd</p>', ['<h1>ab</h1><div><br></div>', 'DIV@0'], '<h1>a</h1><h1>b</h1>',
      '<p>ab&nbsp;</p><p>cd</p>', ['<p>a</p><p>b</p>', 'b@0']
    ])
  end

  it "breaks the host's own line into a `<div>`, and takes an empty list item out of its list" do
    expect([
      typed('abcd', 'e.firstChild', 2, :enter),
      typed('ab', 'e.firstChild', 0, :enter),
      typed('ab', 'e.firstChild', 2, :enter),
      typed('ab<br>cd', 'e.firstChild', 1, :enter),
      typed('a<b>bc</b>d', "e.querySelector('b').firstChild", 1, :enter),
      typed('<ul><li>ab</li></ul>', "e.querySelector('li').firstChild", 2, :enter),
      typed('<ul><li>a</li><li><br></li><li>c</li></ul>', "e.querySelectorAll('li')[1]", 0, :enter),
      typed('<ul><li>a<ul><li><br></li></ul></li></ul>', "e.querySelectorAll('li')[1]", 0, :enter)
    ]).to eq([
      ['ab<div>cd</div>', 'cd@0'], ['<div><br></div>ab', 'ab@0'], ['ab<div><br></div>', 'DIV@0'], ['a<div>b<br>cd</div>', 'b@0'],
      ['a<b>b</b><div><b>c</b>d</div>', 'c@0'], ['<ul><li>ab</li><li><br></li></ul>', 'LI@0'],
      ['<ul><li>a</li></ul><div><br></div><ul><li>c</li></ul>', 'DIV@0'], ['<ul><li>a</li><li><br></li></ul>', 'LI@0']
    ])
  end
end
