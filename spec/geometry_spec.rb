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

  it 'reads a matrix() at double precision, another function as the f32 the engine holds' do
    got = session.evaluate_script("[new DOMMatrix('matrix(1.23456789012,0,0,1,123456789,0)').a, new DOMMatrix('matrix(1e-50,0,0,1,0,0)').a, new DOMMatrix('translate(0.1px)').e]")
    expect(got).to eq([1.23456789012, 1e-50, 0.10000000149011612])                # as Chrome reads each
  end

  it "keeps its state out of the page's reach, and brand-checks its members" do
    got = session.evaluate_script(<<~JS)
      (function () {
        var m = Object.freeze(new DOMMatrix()); m.translateSelf(5);
        var brand; try { Object.create(new DOMPoint(1)).x; brand = 'no throw'; } catch (e) { brand = e.name; }
        return [m.e, Reflect.ownKeys(new DOMRect(1, 2, 3, 4)).length, brand];
      })()
    JS
    expect(got).to eq([5, 0, 'TypeError'])
  end

  it "marshals a DOMRect handed to an async script's callback, and a DOMRectList as its rects" do
    s = session
    expect(s.evaluate_async_script("arguments[0](document.getElementById('d').getBoundingClientRect())")['width']).to eq(30)
    expect(s.evaluate_script("document.getElementById('d').getClientRects()").map {|r| r['width'] }).to eq([30])
  end
end
