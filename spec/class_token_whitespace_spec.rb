# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A class list — and any `~=` list — is separated by ASCII whitespace (HTML's space characters: space, tab, LF, FF,
# CR), not by every Unicode space: `class="a&#xA0;b"` is ONE class, `a b` with a no-break space inside it. Every
# surface that reads the list has to agree, or the page contradicts itself: `querySelectorAll('.b')` found the
# element while the cascade (native) did not style it. Chrome-measured (the values below): the classList is one
# token long, `.b` matches only the tab-separated element, and neither `.b` nor `[data-t~=b]` styles the other.
RSpec.describe 'class token whitespace' do
  it 'splits a class list on ASCII whitespace only, on every surface' do
    html = <<~HTML
      <!DOCTYPE html>
      <style>.b { margin-left: 7px } .b .x { margin-top: 3px } [data-t~="b"] { padding-left: 4px }</style>
      <div id="a" class="a&#xA0;b" data-t="a&#xA0;b"><span id="x" class="x">x</span></div>
      <div id="c" class="c&#x9;b">c</div>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const g = (id, p) => getComputedStyle(document.getElementById(id))[p];
        const a = document.getElementById('a');
        return [a.classList.length, document.querySelectorAll('.b').length, a.matches('.b'),
                g('a', 'marginLeft'), g('x', 'marginTop'), g('a', 'paddingLeft'), g('c', 'marginLeft')];
      })()
    JS
    expect(got).to eq([1, 1, false, '0px', '0px', '0px', '7px'])
  end

  # …the invalidation gates too: a class change to `a&#xA0;b` is the token `a b`, and the rules keyed on it re-key the
  # descendant and the sibling they reach. Chrome-measured.
  it 're-keys what a class holding a no-break space reaches' do
    html = <<~'HTML'
      <!DOCTYPE html>
      <style>.a\A0 b .kid { cursor: move } .a\A0 b + .sib { cursor: help }</style>
      <div id="p"><span class="kid" id="kid">k</span></div><span class="sib" id="sib">s</span>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const cs = (id) => getComputedStyle(document.getElementById(id)).cursor, r = [cs('kid'), cs('sib')];
        document.getElementById('p').className = 'a\u00A0b';
        r.push(cs('kid'), cs('sib'));
        return r;
      })()
    JS
    expect(got).to eq(%w[auto auto move help])
  end
end
