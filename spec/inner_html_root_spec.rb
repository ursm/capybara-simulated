# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `<html>.innerHTML = …` builds its `<head>` and `<body>` from a document parse; the nodes are this document's after it,
# not the throwaway one's — whose `<html>` kept listing them, so a submission (which constructs its entry list from
# the form's document) searched a tree the page no longer had.
RSpec.describe '<html>.innerHTML' do
  it "leaves the parsed nodes in this document, and its form's entry list built" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ['<!DOCTYPE html><p>x</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.documentElement.innerHTML += '<form action="/end"><input type="hidden" name="a" value="1"></form>';
        const f = document.querySelector('form');
        return [f.ownerDocument === document, f.elements.length, [...new FormData(f)].map((e) => e.join('=')).join('&')];
      })()
    JS
    expect(got).to eq([true, 1, 'a=1'])
  end
end
