# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A style sheet's bytes are decoded as CSS Syntax decodes them (§3.2 "determine the fallback encoding"): by its
# response's `Content-Type` charset, else an `@charset` opening it, else its document's encoding, else UTF-8 — a BOM's
# over all of them — its environment the `<link>`'s `charset`, else the importing sheet's or the document's encoding. A
# Latin-1 sheet's `é` was read as UTF-8, a replacement character.
RSpec.describe 'a style sheet’s encoding' do
  e_acute = "\xE9".b
  let(:app) {
    lambda {|env|
      case env['PATH_INFO']
      when '/header.css' then [200, {'content-type' => 'text/css; charset=iso-8859-1'}, ["#a::before { content: \"#{e_acute}\" }".b]]
      when '/rule.css' then [200, {'content-type' => 'text/css'}, ["@charset \"iso-8859-1\";#b::before { content: \"#{e_acute}\" }".b]]
      when '/plain.css' then [200, {'content-type' => 'text/css'}, ["#c::before { content: \"#{e_acute}\" }".b]]
      when '/utf8.css' then [200, {'content-type' => 'text/css'}, ['#d::before { content: "é" }']]
      when '/mislabeled.css' then [200, {'content-type' => 'text/css; charset=iso-8859-1'}, ['#e::before { content: "é" }']]
      when '/parent.css' then [200, {'content-type' => 'text/css'}, ['@charset "iso-8859-1";@import "child.css";']]
      when '/child.css' then [200, {'content-type' => 'text/css'}, ["#f::before { content: \"#{e_acute}\" }".b]]
      when '/linked.css' then [200, {'content-type' => 'text/css'}, ["#g::before { content: \"#{e_acute}\" }".b]]
      when '/utf16.css' then [200, {'content-type' => 'text/css; charset=utf-16le'}, ['#h::before { content: "x" }'.encode('UTF-16LE').b]]
      when '/latin1.html'
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="windows-1252"><link rel=stylesheet href="/plain.css"><p id=c>c</p>']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!doctype html><meta charset="utf-8">
          <link rel=stylesheet href="/header.css"><link rel=stylesheet href="/rule.css"><link rel=stylesheet href="/utf8.css">
          <link rel=stylesheet href="/mislabeled.css"><link rel=stylesheet href="/parent.css">
          <link rel=stylesheet href="/linked.css" charset="iso-8859-1"><link rel=stylesheet href="/utf16.css">
          <p id=a>a</p><p id=b>b</p><p id=d>d</p><p id=e>e</p><p id=f>f</p><p id=g>g</p><p id=h>h</p>
        HTML
      end
    }
  }

  # (…UTF-8 bytes a Latin-1 charset names read as Latin-1 — `Ã©`, as Chrome reads them; an `@import`'s environment the
  # importing sheet's encoding, CSS Cascade 5 §2.2; a `<link charset>` the link's sheet's; a UTF-16 sheet with no BOM by
  # its charset — each Chrome 155's figure)
  it 'decodes by the Content-Type charset, an @charset rule, the environment’s encoding, else UTF-8' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script("['a', 'b', 'd', 'e', 'f', 'g', 'h'].map((id) => getComputedStyle(document.getElementById(id), '::before').content)")
    s.visit '/latin1.html'
    got << s.evaluate_script("getComputedStyle(document.getElementById('c'), '::before').content")
    expect(got).to eq(['"é"', '"é"', '"é"', '"Ã©"', '"é"', '"é"', '"x"', '"é"'])
  end
end
