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
        li1t: () => e.querySelectorAll('li')[1].firstChild
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
end
