# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Backspace and Delete in an editing host are the engine's (editing_delete.rs): a character or (Control) a word back or
# forward, or the selection; a range across blocks joins them; the inline elements a deletion empties go; the white
# space it brings together stays as the line showed it. Every expectation is Chrome's.
RSpec.describe 'deleting in an editing host' do
  let(:session) {
    simulated_session(lambda {|_env|
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><div id=e contenteditable style="width:300px;font:16px monospace"></div>']]
    }).tap {|s| s.visit '/' }
  }

  # The nodes a case names its places by.
  def pick
    <<~JS
      ({
        t0: () => e.firstChild, b0: () => e.querySelector('b').firstChild, p1t: () => e.children[1].firstChild,
        p0t: () => e.children[0].firstChild, p1: () => e.children[1], last: () => e.lastChild,
        li1t: () => e.querySelectorAll('li')[1].firstChild, p2t: () => e.children[2].firstChild
      })
    JS
  end

  def delete(html, at, offset, key, to = nil)
    session.execute_script(<<~JS)
      const e = document.getElementById('e'), p = #{pick};
      e.innerHTML = #{html.to_json};
      e.focus();
      getSelection().collapse(p[#{at.to_json}](), #{offset});
      #{to ? "getSelection().extend(p[#{to[0].to_json}](), #{to[1]});" : ''}
    JS
    session.find(:css, '#e').send_keys(key)
    session.evaluate_script(<<~JS)
      (() => {
        const g = getSelection(), n = g.focusNode;
        return [document.getElementById('e').innerHTML, (n.nodeType === 3 ? n.data : n.nodeName) + '@' + g.focusOffset];
      })()
    JS
  end

  it 'deletes a character, back or forward, past an inline edge, an image, a line break and a surrogate pair' do
    expect([
      delete('abcdef', 't0', 3, :backspace),
      delete('abcdef', 't0', 3, :delete),
      delete('ab<b>cd</b>', 'b0', 0, :backspace),
      delete('ab<i>cd</i>', 't0', 2, :delete),
      delete('ab<br>cd', 'last', 0, :backspace),
      delete('ab<img src="data:,">cd', 'last', 0, :backspace),
      delete("a\u{1F600}b", 't0', 3, :backspace),
      delete('abc', 't0', 3, :delete),
      delete('abc', 't0', 0, :backspace)
    ]).to eq([
      %w[abdef abdef@2], %w[abcef abcef@3], ['a<b>cd</b>', 'a@1'], ['ab<i>d</i>', 'ab@2'], %w[abcd ab@2],
      %w[abcd ab@2], %w[ab ab@1], %w[abc abc@3], %w[abc abc@0]
    ])
  end

  it 'joins blocks, drops an empty line, removes an inline element it empties' do
    expect([
      delete('<p>aaa</p><p>bbb</p>', 'p1t', 0, :backspace),
      delete('<p>aaa</p><p>bbb</p>', 'p0t', 3, :delete),
      delete('<p>aaa</p><p><br></p>', 'p1', 0, :backspace),
      delete('<ul><li>aa</li><li>bb</li></ul>', 'li1t', 0, :backspace),
      delete('<p>aaa</p><p>bbb</p>', 'p0t', 1, :backspace, ['p1t', 2]),
      delete('abcdef', 't0', 1, :delete, ['t0', 4]),
      delete('x<b>y</b>z', 'b0', 1, :backspace)
    ]).to eq([
      ['<p>aaabbb</p>', 'aaabbb@3'], ['<p>aaabbb</p>', 'aaabbb@3'], ['<p>aaa</p>', 'aaa@3'],
      ['<ul><li>aabb</li></ul>', 'aabb@2'], ['<p>ab</p>', 'ab@1'], %w[aef aef@1], %w[xz x@1]
    ])
  end

  it 'deletes a word, keeping the white space it brings together' do
    expect([
      delete('foo bar baz', 't0', 7, %i[control backspace]),
      delete('foo bar baz', 't0', 4, %i[control delete])
    ]).to eq([["foo&nbsp; baz", "foo  baz@4"], ["foo&nbsp; baz", "foo  baz@4"]])
  end

  # …the innerHTML a deletion leaves, the caret at the node `at` (a script expression over `e`, the host) and `offset`.
  def deleted(html, at, offset, key, to = nil)
    session.execute_script(<<~JS)
      const e = document.getElementById('e');
      e.innerHTML = #{html.to_json};
      e.focus();
      getSelection().collapse(#{at}, #{offset});
      #{to ? "getSelection().extend(#{to[0]}, #{to[1]});" : ''}
    JS
    session.find(:css, '#e').send_keys(key)
    session.evaluate_script("document.getElementById('e').innerHTML")
  end

  it "joins no table's cells, and takes a non-editable island whole" do
    table = '<table><tbody><tr><td>aa</td><td>bb</td></tr></tbody></table>'
    expect([
      deleted(table, "e.querySelectorAll('td')[1].firstChild", 0, :backspace),
      deleted(table, "e.querySelector('td').firstChild", 2, :delete),
      deleted('<p>aa</p><table><tr><td>bb</td></tr></table>', "e.querySelector('td').firstChild", 0, :backspace),
      deleted('<p>aa</p><table><tr><td>bb</td></tr></table>', "e.querySelector('p').firstChild", 1, :backspace, ["e.querySelector('td').firstChild", 1]),
      deleted('a<span contenteditable="false">XX</span>b', 'e.lastChild', 0, :backspace),
      deleted('a<span contenteditable="false">XX</span>b', 'e.firstChild', 1, :delete),
      deleted('<p>a</p><div contenteditable="false">XX</div><p>b</p>', 'e.lastChild.firstChild', 0, :backspace)
    ]).to eq([
      table, table, '<p>aa</p><table><tbody><tr><td>bb</td></tr></tbody></table>',
      '<p>a</p><table><tbody><tr><td>b</td></tr></tbody></table>', 'ab', 'ab', '<p>ab</p>'
    ])
  end

  it 'joins a block it holds or that holds it, and leaves no emptied element behind' do
    expect([
      deleted('aa<p>bb</p>', "e.querySelector('p').firstChild", 0, :backspace),
      deleted('<p>aa</p>bb', 'e.lastChild', 0, :backspace),
      deleted('<ul><li>aa<ul><li>bb</li></ul></li></ul>', "e.querySelectorAll('li')[1].firstChild", 0, :backspace),
      deleted('ab<b>c</b>d', 'e.firstChild', 2, :delete),
      deleted('ab<b>cd</b>e', 'e.firstChild', 1, :backspace, ["e.querySelector('b').firstChild", 2]),
      deleted('a', 'e.firstChild', 1, :backspace)
    ]).to eq(['aabb', '<p>aabb</p>', '<ul><li>aabb</li></ul>', 'abd', 'ae', '<br>'])
  end

  it 'joins out of the inline elements around the start, keeps the next line, and its own' do
    expect([
      deleted('<div><b>aa</b><p>bb</p></div>', "e.querySelector('p').firstChild", 0, :backspace),
      deleted('<a href="#">aa</a><p>bb</p>', "e.querySelector('p').firstChild", 0, :backspace),
      deleted('<b>aa</b><p>bb</p>', "e.querySelector('b').firstChild", 2, :delete),
      deleted('aa<p>bb</p>cc', "e.querySelector('p').firstChild", 0, :backspace),
      deleted('<p>a</p>bb<br>cc', 'e.childNodes[1]', 0, :backspace),
      deleted('<p>aa</p><p>bb</p>', 'e', 1, :delete, ['e.lastChild.firstChild', 1])
    ]).to eq([
      '<div><b>aa</b>bb</div>', '<a href="#">aa</a>bb', '<b>aa</b>bb', 'aabb<br>cc', '<p>abb</p>cc', '<p>aa</p><p>b</p>'
    ])
  end

  it 'takes a block atom whole, joins across a block island at the joint, and leaves an island a selection ends in' do
    island = 'a<span contenteditable="false">XY</span>bc'
    nested = 'a<span contenteditable="false">X<span contenteditable="true">yz</span>X</span>b'
    expect([
      delete('<p>a</p><hr><p>b</p>', 'p2t', 0, :backspace),
      delete('<p>a</p><hr><p>b</p>', 'p0t', 1, :delete),
      delete('<p>a</p><img style="display:block" src="data:,"><p>b</p>', 'p2t', 0, :backspace).first,
      delete('<p>a</p><div contenteditable="false">XX</div><p>b</p>', 'p2t', 0, :backspace),
      deleted(island, 'e.firstChild', 0, :backspace, ['e.childNodes[1].firstChild', 1]),
      deleted(nested, 'e.lastChild', 0, :backspace)
    ]).to eq([
      ['<p>a</p><p>b</p>', 'b@0'], ['<p>a</p><p>b</p>', 'a@1'], '<p>a</p><p>b</p>', ['<p>ab</p>', 'ab@1'], island, nested
    ])
  end

  # …and where the caret goes — what a "Z" typed after the deletion shows.
  def typed(html, at, offset, key, to = nil)
    deleted(html, at, offset, key, to)
    session.find(:css, '#e').send_keys('Z')
    session.evaluate_script("document.getElementById('e').innerHTML")
  end

  it 'keeps a block island nothing joins across, and puts the caret where the deletion leaves the line' do
    island = '<div contenteditable="false">XX</div>'
    expect([
      typed("#{island}<p>b</p>", 'e.lastChild.firstChild', 0, :backspace),
      typed("<p>a</p>#{island}", 'e.firstChild.firstChild', 1, :delete),
      typed('<span contenteditable="false">X</span><p>bb</p>', 'e.lastChild.firstChild', 0, :backspace),
      typed('aa<span contenteditable="false">X</span><p>bb</p>', 'e.lastChild.firstChild', 0, :backspace),
      typed('<p>aa</p><p>bb</p>', 'e', 1, :delete, ['e.lastChild.firstChild', 1]),
      typed("<p>a</p>#{island}<p>b</p>", 'e.firstChild.firstChild', 1, :delete),
      deleted("aa<p>bb</p>\n", "e.querySelector('p').firstChild", 0, :backspace),
      deleted('aa<p>bb</p><br>cc', "e.querySelector('p').firstChild", 0, :backspace)
    ]).to eq([
      "#{island}<p>Zb</p>", "<p>aZ</p>#{island}", '<p>Zbb</p>', 'aaZbb', '<p>aa</p><p>Zb</p>', '<p>aZb</p>', "aabb\n",
      'aabb<br><br>cc'
    ])
  end
end
