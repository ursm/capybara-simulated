# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A key's caret move reads the laid-out text only where it moves by the text's lines — an editing host's or a
# textarea's Home / End, Up / Down (caret_moves.rs `TEXT_WANTED`): Home / End in an input is an edit of its value, and
# Control+Home / End's edge is no line's, so neither lays the page out. Laying it out for every move was ~13 ms a key on
# a 3000-paragraph page.
RSpec.describe 'a caret move that reads no line' do
  it 'lays nothing out' do
    paragraphs = Array.new(300) {|i| "<p>paragraph #{i}</p>" }.join
    html = %(<!DOCTYPE html><meta charset="utf-8"><input id=i value="abc"><textarea id=t>one\ntwo</textarea>#{paragraphs})
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    passes = -> { s.evaluate_script('globalThis.__csimLayoutPasses()') }
    input = s.find('#i')
    input.send_keys(:end)
    moves = [[:home], [:end], [:up], [:down]].map {|keys|
      s.execute_script("document.body.append(document.createElement('p'))")
      before = passes.call
      input.send_keys(*keys)
      passes.call - before
    }
    textarea = s.find('#t')
    textarea.send_keys(:end)
    edges = [[:control, :home], [:control, :end]].map {|keys|
      s.execute_script("document.body.append(document.createElement('p'))")
      before = passes.call
      textarea.send_keys(keys)
      passes.call - before
    }
    expect([moves, edges]).to eq([[0, 0, 0, 0], [0, 0]])
    expect(s.evaluate_script("[document.getElementById('i').selectionStart, document.getElementById('t').selectionStart]")).to eq([3, 7])
  end
end
