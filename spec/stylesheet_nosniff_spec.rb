# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A style sheet served with `X-Content-Type-Options: nosniff` is one only where it is `text/css` (Fetch "should
# response to request be blocked due to nosniff?", destination `style`): one with no type, and in a quirks-mode document
# a same-origin `text/plain` one — each a sheet without the header — is none under it, its `<link>`'s load an `error`.
RSpec.describe 'a style sheet under nosniff' do
  let(:app) {
    sheet = ->(id) { "##{id} { color: rgb(0, 128, 0) }" }
    lambda {|env|
      case env['PATH_INFO']
      when '/css.css' then [200, {'content-type' => 'text/css', 'x-content-type-options' => 'nosniff'}, [sheet['a']]]
      when '/untyped.css' then [200, {'x-content-type-options' => 'nosniff'}, [sheet['b']]]
      when '/plain.css' then [200, {'content-type' => 'text/plain', 'x-content-type-options' => 'nosniff'}, [sheet['c']]]
      when '/plain-sniffed.css' then [200, {'content-type' => 'text/plain'}, [sheet['d']]]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <html><meta charset="utf-8">
          <link rel=stylesheet href="/css.css" onload="seen.push('a load')" onerror="seen.push('a error')">
          <link rel=stylesheet href="/untyped.css" onload="seen.push('b load')" onerror="seen.push('b error')">
          <link rel=stylesheet href="/plain.css" onload="seen.push('c load')" onerror="seen.push('c error')">
          <link rel=stylesheet href="/plain-sniffed.css" onload="seen.push('d load')" onerror="seen.push('d error')">
          <script>window.seen = [];</script>
          <p id=a>a</p><p id=b>b</p><p id=c>c</p><p id=d>d</p>
        HTML
      end
    }
  }

  it 'takes text/css alone, in a quirks-mode document too' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      [document.compatMode, seen.slice().sort(), ['a', 'b', 'c', 'd'].map((id) => getComputedStyle(document.getElementById(id)).color)]
    JS
    green, black = 'rgb(0, 128, 0)', 'rgb(0, 0, 0)'
    expect(got).to eq(['BackCompat', ['a load', 'b error', 'c error', 'd load'], [green, black, black, green]])
  end
end
