# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The Geometry Interfaces (geometry.js over dom_matrix.rs) as a test reaches them — css/geometry in the WPT gate holds
# the rest: a CSS transform list parsed into a DOMMatrix, getClientRects a DOMRectList, and a geometry object returned
# from a script marshalled as WebDriver's JSON clone has it — through its `toJSON`, nested too, since its attributes
# live on its prototype.
RSpec.describe 'geometry interfaces' do
  let(:app) { ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body style="margin:0"><div id="d" style="width:30px;height:20px"></div></body>']] } }

  def session
    s = simulated_session(app)
    s.visit '/'
    s
  end

  it 'parses a transform list into a matrix' do
    expect(session.evaluate_script("new DOMMatrix('translate(10px, 5px) scale(2) rotate(90deg)').toString()")).to eq('matrix(0, 2, -2, 0, 10, 5)')
  end

  it 'answers getClientRects with a DOMRectList' do
    got = session.evaluate_script(<<~JS)
      (function () {
        var l = document.getElementById('d').getClientRects();
        return [Object.prototype.toString.call(l), l.length, l.item(0).width, Array.isArray(l)];
      })()
    JS
    expect(got).to eq(['[object DOMRectList]', 1, 30, false])
  end

  it 'marshals a returned DOMRect through its toJSON, nested in an array or an object too' do
    got = session.evaluate_script("(function () { var r = document.getElementById('d').getBoundingClientRect(); return [r, {rect: r}]; })()")
    expect(got[0].values_at('width', 'height', 'right')).to eq([30, 20, 30])
    expect(got[1]['rect']['width']).to eq(30)
  end
end
