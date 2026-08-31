# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The line breaks `innerText` puts between blocks — the "required line break count" half of the
# rendered-text collection steps. The walk appended a `\n` the moment it met a block and skipped a
# child whose collected text was empty, which got three things wrong at once: an empty block
# contributed nothing where it should contribute a break, two of them contributed two breaks where
# the requirements MERGE into one, and a nested one contributed a break per level.
#
# Modelling the requirement as a PENDING count — written only when something follows it, never at
# the end of a walk, because a trailing break is the PARENT's to ask for — answers all three, and
# `<p>`'s count of 2 falls out of the same place.
#
# Every figure is Chrome 151-measured on this machine.
RSpec.describe 'innerText line breaks' do
  def inner_text(html)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (function () {
        var d = document.createElement('div');
        d.innerHTML = #{html.to_json};
        document.body.appendChild(d);
        return d.innerText;
      })()
    JS
  end

  # An empty block still generates a box, and a box on its own line is a line break.
  it 'breaks around an empty block' do
    expect(inner_text('abc<div></div>def')).to eq("abc\ndef")
    expect(inner_text('abc<hr>def')).to        eq("abc\ndef")
  end

  # …and two of them ask for the same break, not one each: the requirements merge, and the
  # collapsible white-space between them renders nothing at all.
  it 'merges the breaks two blocks ask for' do
    expect(inner_text('abc <hr> <hr>def')).to             eq("abc\ndef")
    expect(inner_text('abc<div></div><div></div>def')).to eq("abc\ndef")
  end

  # A block that does not RENDER contributes neither text nor break — the question the walk asks is
  # whether the box exists, not whether the string does.
  it 'ignores a block that generates no box' do
    expect(inner_text('abc<div style="display:none"></div>def')).to eq('abcdef')
    expect(inner_text('abc<span></span>def')).to                    eq('abcdef')
  end

  # Nesting asks once per boundary, not once per level: the walk never writes the break its own
  # block-ness earns, because that is the parent's to ask for.
  it 'asks once per boundary however deep the blocks nest' do
    expect(inner_text('abc<table><td>def</table>ghi')).to eq("abc\ndef\nghi")
    expect(inner_text('a<div>b</div>c')).to               eq("a\nb\nc")
    expect(inner_text('<table><tr><td>abc<caption>def</caption></table>')).to eq("abc\ndef")
  end

  # A `<p>` asks for TWO — a blank line either side — and keeps asking however it is displayed.
  it 'gives a paragraph a blank line either side' do
    expect(inner_text('123<p style="display:block">abc')).to        eq("123\n\nabc")
    expect(inner_text('123<p style="display:inline-block">abc')).to eq("123\n\nabc")
    expect(inner_text('abc<p></p>def')).to                          eq("abc\n\ndef")
  end

  # A cell contributes its TAB whether or not it holds anything, and the trailing ones survive:
  # trimming every kind of whitespace off a line took the separators with it.
  it 'keeps the tab an empty cell contributes' do
    expect(inner_text('<table><tr><td>abc<td><td>def</table>')).to eq("abc\t\tdef")
    expect(inner_text('<table><tr><td>abc<td><td></table>')).to    eq("abc\t\t")
  end

  # A shadow HOST only looks empty from here — its rendered content is in its shadow tree, which
  # this walk does not descend into — so it is not the empty block the rule above is about.
  # Capybara's own suite pins the shape: an empty-looking host between two inlines reads as a
  # space, not a line break.
  it 'does not treat a shadow host as an empty block' do
    html = <<~HTML
      <!DOCTYPE html><html><body><div id="host"></div><script>
        var root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML = '<span>some text</span>\\n<div id="h"></div>\\n<a href="scroll.html">scroll.html</a>';
        root.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = '<div>nested text</div>';
      </script></body></html>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    expect(session.find(:css, '#host').shadow_root.text).to eq('some text scroll.html')
  end
end
