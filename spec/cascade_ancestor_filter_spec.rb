# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Rule matching rejects a candidate whose ancestor chain cannot carry the identifiers its selector
# requires (the ancestor bloom in cascade.js). The filter is REJECT-ONLY, so the property under
# test is one-sided: it must never refuse a rule that would have matched. Every example here is a
# shape where the rule DOES apply — a false negative shows up as the style silently not landing.
RSpec.describe 'the ancestor reject filter' do
  def page_with(css, body)
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'},
       ["<html><head><style>#{css}</style></head><body>#{body}</body></html>"]]
    })
    s.visit '/'
    s
  end

  def display_of(session, selector)
    session.evaluate_script("getComputedStyle(document.querySelector('#{selector}')).display")
  end

  it 'keeps a rule whose ancestor requirement is spelled in another case' do
    # css-what marks `[… i]` with `ignoreCase`, and hashing the value verbatim asked for a bit the
    # element — whose class is lowercase — could never have. Measured against Chrome, which
    # applies both of these.
    s = page_with('[class~="FOO" i] .c { display: none } [id="BAR" i] .d { display: none }',
                  '<div class="foo"><i class="c">x</i></div><div id="bar"><i class="d">y</i></div>')
    expect(display_of(s, '.c')).to eq('none')
    expect(display_of(s, '.d')).to eq('none')
  end

  it 'keeps a rule whose ancestor sits above a sibling combinator' do
    # `.a ~ .b .c`: `.b` IS an ancestor of `.c`, `.a` is only its sibling — so collection has to
    # stop at the `~` rather than requiring `.a` above us.
    s = page_with('.a ~ .b .c { display: none }',
                  '<div class="a"></div><div class="b"><i class="c">x</i></div>')
    expect(display_of(s, '.c')).to eq('none')
  end

  it 'keeps a rule whose ancestor identifiers are inside a functional pseudo' do
    # `:is(.a) .c` constrains an ancestor, but not with any identifier the filter may require:
    # descending into the pseudo would demand `.a` of a chain that legitimately satisfies the
    # selector another way.
    s = page_with(':is(.a, .b) .c { display: none }',
                  '<div class="b"><i class="c">x</i></div>')
    expect(display_of(s, '.c')).to eq('none')
  end

  it 'keeps a rule when an ancestor gains the required class after the first read' do
    # The bloom is memoised on the context epoch; a class written on an ancestor AFTER a read has
    # already warmed it must move that epoch, or the filter answers from a chain that no longer
    # exists.
    s = page_with('.on .c { display: none }', '<div id="host"><i class="c">x</i></div>')
    expect(display_of(s, '.c')).to eq('inline')
    s.evaluate_script("document.getElementById('host').className = 'on'; 1")
    expect(display_of(s, '.c')).to eq('none')
  end

  it 'keeps a rule for an element moved under a matching ancestor' do
    s = page_with('.on .c { display: none }',
                  '<div class="on" id="a"></div><div id="b"><i class="c">x</i></div>')
    expect(display_of(s, '.c')).to eq('inline')
    s.evaluate_script("document.getElementById('a').appendChild(document.querySelector('.c')); 1")
    expect(display_of(s, '.c')).to eq('none')
  end

  it 'still rejects what genuinely does not match' do
    # The other side of the contract: the filter exists to refuse, and a chain without the
    # identifier must keep the rule off.
    s = page_with('.on .c { display: none }', '<div class="off"><i class="c">x</i></div>')
    expect(display_of(s, '.c')).to eq('inline')
  end
end
