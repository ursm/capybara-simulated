# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A restyle that only repaints — a `:hover` / `:active` colour, a colour transition — lays nothing out again
# (style.rs `layout_relevant_change`, `reconcile_animated`); one that moves a box does, and getComputedStyle reads the
# new values either way.
RSpec.describe 'paint-only restyles' do
  html = <<~HTML
    <!DOCTYPE html><meta charset=utf-8>
    <style>
      button { transition: color .2s, background-color .2s, border-color .2s, box-shadow .2s }
      .paint:hover { color: rgb(255, 0, 0); background-color: rgb(0, 0, 255); outline: 2px solid red; box-shadow: 0 0 3px red; border-color: green }
      .paint:active { background-color: rgb(0, 255, 0) }
      .box:hover { padding-left: 30px }
    </style>
    <button id=p class=paint style="border: 1px solid black">p</button><button id=q class=paint>q</button><button id=b class=box>b</button>
  HTML
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] }) }

  def passes = session.evaluate_script('__csimLayoutPasses()')
  def width(id) = session.evaluate_script("document.getElementById('#{id}').getBoundingClientRect().width")
  def style(id, prop) = session.evaluate_script("getComputedStyle(document.getElementById('#{id}')).#{prop}")

  it 'lays nothing out again for a colour, and lays out for a box' do
    session.visit '/'
    session.find('#q').hover
    width('p')
    before = passes
    session.find('#p').hover
    session.find('#q').hover
    session.find('#p').click
    width('p')
    expect(passes).to eq(before)
    session.find('#p').hover
    expect([style('p', 'outlineStyle'), style('q', 'outlineStyle')]).to eq(%w[solid none])
    session.find('#b').hover
    expect(width('b')).to be > width('q') + 20
    expect(passes).to be > before
  end
end
