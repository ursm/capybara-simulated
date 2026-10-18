# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `<html>.innerHTML = …` builds its `<head>` and `<body>` from a document parse; the nodes are this document's after it,
# not the throwaway one's — whose `<html>` kept listing them, so a submission (which constructs its entry list from
# the form's document) searched a tree the page no longer had. Only an HTML `<html>` does, and only an HTML `<template>`
# takes the parse into its contents: one of another namespace is no html or template element, and keeps the nodes as
# its children (Chrome).
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
  it 'parses into an SVG or MathML `html` or `template` as into any element' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, ['<!DOCTYPE html><p>x</p>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const svg = 'http://www.w3.org/2000/svg', mathml = 'http://www.w3.org/1998/Math/MathML';
        const [t, h, m] = [[svg, 'template'], [svg, 'html'], [mathml, 'html']].map(([ns, name]) => {
          const el = document.createElementNS(ns, name);
          el.innerHTML = '<p>a</p>';
          return el;
        });
        return [t.childNodes.length, t.innerHTML, 'content' in t, h.innerHTML, m.innerHTML];
      })()
    JS
    expect(got).to eq([1, '<p>a</p>', false, '<p>a</p>', '<p>a</p>'])
  end
end
