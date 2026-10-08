# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Path2D, generated from its IDL: its path in its internal slots, its arguments converted by the binding.
RSpec.describe 'Path2D bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><iframe></iframe>']] })
    s.visit('/')
    s
  }

  def error(js) = "(() => { try { #{js}; return 'none'; } catch (e) { return e.name; } })()"

  # (…addPath of a path with no subpaths returns before its matrix is made: an inconsistent one refused only for a path
  # that has some — Chrome and Firefox refuse it either way)
  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const path = new Path2D('M0 0 L10 10');
        return [
          [Object.prototype.toString.call(path), Object.keys(path), Path2D.length],
          #{error('Path2D()')},
          #{error('path.moveTo(0)')},
          #{error('path.lineTo(Symbol(), 0)')},
          #{error('path.arc(0, 0, -1, 0, 1)')},
          #{error('path.addPath({})')},
          #{error('path.addPath(path, {a: 1, m11: 2})')},
          #{error('path.addPath(new Path2D(), {a: 1, m11: 2})')},
          #{error('Path2D.prototype.moveTo.call({}, 0, 0)')},
          #{error("path.roundRect(0, 0, 1, 1, [1, 2, 3, 4, 5])")}
        ];
      })()
    JS
    expect(got).to eq([
      ['[object Path2D]', [], 0],
      'TypeError', 'TypeError', 'TypeError', 'IndexSizeError', 'TypeError', 'TypeError', 'none', 'TypeError', 'RangeError'
    ])
  end

  # A Path2D is one by its slots, whichever realm made it: a frame's fills a context here and seeds a path here; and
  # addPath with no matrix appends it as it is, with a non-finite one nothing.
  it "fills and copies any realm's path, and appends through a matrix" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 4;
        const ctx = canvas.getContext('2d');
        const px = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
        const theirs = new frames[0].Path2D();
        theirs.rect(0, 0, 1, 1);
        ctx.fill(theirs);
        const copy = new Path2D(theirs);
        copy.rect(2, 0, 1, 1);
        const shifted = new Path2D();
        shifted.addPath(theirs, {e: 0, f: 2});
        shifted.addPath(theirs, {e: NaN});
        shifted.addPath(theirs);
        ctx.clearRect(0, 0, 4, 4);
        ctx.fill(copy);
        const copied = [px(0, 0), px(2, 0)];
        ctx.clearRect(0, 0, 4, 4);
        ctx.fill(shifted);
        return [copied, [px(0, 0), px(0, 2), px(2, 0)], ctx.isPointInPath(theirs, 0.5, 0.5)];
      })()
    JS
    expect(got).to eq([[255, 255], [255, 255, 0], true])
  end
end
