# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The style data the traversal keeps an element holds its EAGER pseudo-elements' styles alone (`::before`, `::after`,
# `::first-line`, `::first-letter`): a lazy one's — `::marker`, `::placeholder`, `::selection`, `::backdrop` — is
# cascaded when asked for (style.rs `eager_style`). Asked of the data, one of an element that has an eager one too was
# an index past its list, a panic that took the process down.
RSpec.describe 'a lazy pseudo-element of an element with an eager one' do
  it 'is cascaded when asked for, and leaves the engine styling the page' do
    html = <<~HTML
      <!DOCTYPE html><meta charset="utf-8">
      <style>
        #i::before, #l::before { content: 'x' }
        #i::placeholder { color: rgb(1, 2, 3) }
        #l::marker { color: rgb(4, 5, 6) }
        #i::selection { color: rgb(7, 8, 9) }
        #after { color: rgb(10, 11, 12) }
      </style>
      <input id=i placeholder=p><ul><li id=l>l</li></ul><p id=after>after</p>
    HTML
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    read = ->(id, pseudo) { s.evaluate_script("getComputedStyle(document.getElementById('#{id}'), #{pseudo ? "'#{pseudo}'" : 'null'}).color") }
    # (…each lazy one asked of the data first: `::marker`'s and `::selection`'s own rules are another gap, not read here)
    [%w[l ::marker], %w[i ::selection], %w[i ::backdrop]].each {|id, pseudo| read.(id, pseudo) }
    expect([read.('i', '::before'), read.('i', '::placeholder'), read.('i', '::backdrop'), read.('after', nil)]).to eq(
      ['rgb(0, 0, 0)', 'rgb(1, 2, 3)', 'rgb(0, 0, 0)', 'rgb(10, 11, 12)']
    )
  end
end
