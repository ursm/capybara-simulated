# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CanvasGradient and CanvasPattern, generated from their IDL: opaque objects a context makes, their state in internal
# slots.
RSpec.describe 'Canvas paint bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body><iframe></iframe>']] })
    s.visit('/')
    s
  }

  def error(js) = "(() => { try { #{js}; return 'none'; } catch (e) { return e.name; } })()"

  it 'is what its IDL says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const ctx = document.createElement('canvas').getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 10, 0);
        const pattern = ctx.createPattern(document.createElement('canvas'), 'repeat');
        return [
          [Object.prototype.toString.call(gradient), Object.prototype.toString.call(pattern), Object.keys(gradient), Object.keys(pattern)],
          #{error('new CanvasGradient()')},
          #{error('new CanvasPattern()')},
          #{error("gradient.addColorStop(0)")},
          #{error("gradient.addColorStop(NaN, 'red')")},
          #{error("gradient.addColorStop(1.5, 'red')")},
          #{error("gradient.addColorStop(0.5, 'not a colour')")},
          #{error("CanvasGradient.prototype.addColorStop.call({}, 0, 'red')")},
          #{error("pattern.setTransform({a: 1, m11: 2})")},
          #{error('CanvasPattern.prototype.setTransform.call(gradient)')}
        ];
      })()
    JS
    expect(got).to eq([
      ['[object CanvasGradient]', '[object CanvasPattern]', [], []],
      'TypeError', 'TypeError', 'TypeError', 'TypeError', 'IndexSizeError', 'SyntaxError', 'TypeError', 'TypeError', 'TypeError'
    ])
  end

  # A fill style is a gradient or a pattern by what it is, whichever realm made it: a frame's context's gradient fills
  # (a style a page's `instanceof` would refuse); `setTransform()` with no matrix resets the pattern's to the identity.
  it "paints with any realm's gradient, and resets a pattern's transform" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const px = (ctx) => [...ctx.getImageData(0, 0, 1, 1).data];
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 4;
        const ctx = canvas.getContext('2d');
        const theirs = frames[0].document.createElement('canvas').getContext('2d').createLinearGradient(0, 0, 4, 0);
        theirs.addColorStop(0, '#0f0');
        theirs.addColorStop(1, '#0f0');
        ctx.fillStyle = theirs;
        ctx.fillRect(0, 0, 4, 4);
        const green = px(ctx);
        const tile = document.createElement('canvas');
        tile.width = tile.height = 2;
        const t = tile.getContext('2d');
        t.fillStyle = '#f00';
        t.fillRect(0, 0, 1, 1);
        const pattern = ctx.createPattern(tile, 'no-repeat');
        pattern.setTransform(new DOMMatrix().translate(2, 2));
        pattern.setTransform();
        ctx.clearRect(0, 0, 4, 4);
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, 4, 4);
        return [green, ctx.fillStyle === pattern, px(ctx)];
      })()
    JS
    expect(got).to eq([[0, 255, 0, 255], true, [255, 0, 0, 255]])
  end
end
