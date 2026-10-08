# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# ImageData, generated from its IDL: two constructors told apart by their first argument, its state in internal slots.
RSpec.describe 'ImageData bindings' do
  let(:session) {
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset="utf-8"><body>']] })
    s.visit('/')
    s
  }

  def error(js) = "(() => { try { #{js}; return 'none'; } catch (e) { return e.name; } })()"

  # 2d.imageData.object.ctor.basics.html's assertions, but one: it holds `new ImageData(1 << 31, 1 << 31)` to an
  # IndexSizeError (Chrome's and Firefox's), where "initialize an ImageData" has rethrown the allocation's RangeError since
  # whatwg/html#520 (2016) — the subtest is out of scope on that alone (wpt_out_of_scope.yml), and these keep the rest.
  it 'constructs as HTML says' do
    got = session.evaluate_script(<<~JS)
      [
        #{error('ImageData(1, 1)')},
        #{error('new ImageData(10)')},
        #{error('new ImageData(0, 10)')},
        #{error('new ImageData(10, 0)')},
        #{error("new ImageData('width', 'height')")},
        #{error('new ImageData(1 << 31, 1 << 31)')},
        #{error('new ImageData(new Uint8ClampedArray(0))')},
        #{error('new ImageData(new Uint8Array(100), 25)')},
        #{error('new ImageData(new Uint8ClampedArray(27), 2)')},
        #{error('new ImageData(new Uint8ClampedArray(28), 7, 0)')},
        #{error('new ImageData(new Uint8ClampedArray(104), 14)')},
        #{error('new ImageData(self, 4, 4)')},
        #{error('new ImageData(null, 4, 4)')},
        #{error('new ImageData(new Uint8ClampedArray(400), 1 << 31)')},
        #{error('new ImageData(new Uint8ClampedArray(400), 1 << 24, 1 << 31)')},
        #{error('new ImageData(new Uint16Array(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer, 0, 16), 4, 2)')},
        new ImageData(new Uint8ClampedArray(28), 7).height
      ]
    JS
    expect(got).to eq(%w[
      TypeError TypeError IndexSizeError IndexSizeError IndexSizeError RangeError TypeError IndexSizeError
      InvalidStateError IndexSizeError IndexSizeError TypeError TypeError IndexSizeError IndexSizeError TypeError
    ] + [1])
  end

  # Its pixel array is the one given, not a copy; a float16 one is a Float16Array, eight bytes to a pixel, an array of
  # the other format's type an InvalidStateError once the lengths are checked.
  it 'keeps the array it is given, of its pixel format' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const data = new Uint8ClampedArray(400);
        const image = new ImageData(data, 20);
        const half = new ImageData(2, 3, {pixelFormat: 'rgba-float16', colorSpace: 'display-p3'});
        return [
          [image.data === data, image.width, image.height, image.colorSpace, image.pixelFormat],
          [Object.prototype.toString.call(half.data), half.data.length, half.pixelFormat, half.colorSpace],
          #{error("new ImageData(new Float16Array(8), 1, 2, {pixelFormat: 'rgba-float16'})")},
          #{error("new ImageData(new Float16Array(8), 1)")},
          #{error("new ImageData(new Float16Array(8), 3)")},
          #{error("new ImageData(new Uint8ClampedArray(8), 1, 1, {pixelFormat: 'rgba-float16'})")},
          Object.keys(image),
          #{error("Object.getOwnPropertyDescriptor(ImageData.prototype, 'width').get.call({})")}
        ];
      })()
    JS
    expect(got).to eq([
      [true, 20, 5, 'srgb', 'rgba-unorm8'],
      ['[object Float16Array]', 24, 'rgba-float16', 'display-p3'],
      'none',
      'InvalidStateError',
      'IndexSizeError',
      'InvalidStateError',
      [],
      'TypeError'
    ])
  end

  # 2d.imageData.object.ctor.pixelFormat.html's assertions, but its two of an array of the other format's type whose
  # lengths do not fit (out of scope, wpt_out_of_scope.yml): HTML checks the lengths first, an IndexSizeError here.
  it 'constructs each pixel format as HTML says' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const half = new ImageData(100, 50, {pixelFormat: 'rgba-float16'});
        half.data.set([0, -1, 0.5, 1024], 16);
        const data = new Float16Array(200), byte = new Uint8ClampedArray(200);
        return [
          new ImageData(100, 50).pixelFormat, half.pixelFormat, [...half.data.subarray(16, 20)],
          new ImageData(data, 10, 5, {pixelFormat: 'rgba-float16'}).data === data,
          #{error("new ImageData(data, 10, 5)")},
          #{error("new ImageData(byte, 10, 5, {pixelFormat: 'rgba-float16'})")},
          new ImageData(byte, 10, 5).data === byte,
          ['unorm8', 'float16', 'rgba8unorm', 'rgba16float'].map((pixelFormat) => #{error('new ImageData(byte, 10, 5, {pixelFormat})')})
        ];
      })()
    JS
    expect(got).to eq(['rgba-unorm8', 'rgba-float16', [0, -1, 0.5, 1024], true, 'IndexSizeError', 'IndexSizeError', true, %w[TypeError] * 4])
  end

  # A structured clone copies its pixels and keeps its other slots; putImageData reads its slots, not its getters.
  it 'clones, and is drawn from its slots' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const image = new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1, {colorSpace: 'display-p3'});
        const clone = structuredClone(image);
        const ctx = document.createElement('canvas').getContext('2d');
        Object.defineProperty(image, 'data', {value: new Uint8ClampedArray(4)});
        ctx.putImageData(image, 0, 0);
        const half = new ImageData(new Float16Array([1, 0.5, 0, 1]), 1, 1, {pixelFormat: 'rgba-float16'});
        ctx.putImageData(half, 1, 0);
        return [
          clone instanceof ImageData, clone.data !== image.data, [...clone.data], clone.colorSpace, clone.pixelFormat,
          [...ctx.getImageData(1, 0, 1, 1).data],
          #{error('ctx.getImageData(10, 0xffffffff, 2147483647, 10)')}
        ];
      })()
    JS
    expect(got).to eq([true, true, [1, 2, 3, 255], 'display-p3', 'rgba-unorm8', [255, 128, 0, 255], 'TypeError'])
  end
end
