# frozen_string_literal: true

require 'capybara/simulated'
require 'zlib'

# An image a spec reads back — a screenshot, a canvas's encoding, a reftest's rendering — decoded by csim_native's own
# decoder, the one a page's images go through: RGBA, one row after another. The specs need no image library of their
# own, as the driver needs none.
class Raster
  attr_reader :width, :height, :rgba

  def self.read(path)
    new(File.binread(path))
  end

  def initialize(bytes)
    decoded = Capybara::Simulated::Native.decode_image(bytes.b, 0, 0)
    raise ArgumentError, 'not an image the decoder reads' unless decoded && decoded['bytes']

    @width, @height, @rgba = decoded['width'], decoded['height'], decoded['bytes']
  end

  # The pixel at (`x`, `y`), `[r, g, b, a]`. Bounds-checked: the offset arithmetic would otherwise wrap an
  # out-of-range x onto the NEXT ROW and answer with a real pixel from the wrong place — which is exactly how a stale
  # coordinate passed once, reading red where the assertion wanted white.
  def [](x, y)
    raise ArgumentError, "(#{x}, #{y}) is outside the #{width}x#{height} raster" \
      unless x.between?(0, width - 1) && y.between?(0, height - 1)

    rgba.byteslice(((y * width) + x) * 4, 4).bytes
  end

  # The columns with ink in the rows `y0...y1` — a pixel whose red is under 128 — left to right.
  def ink_columns(y0, y1)
    (0...width).select {|x| (y0...y1).any? {|y| rgba.getbyte(((y * width) + x) * 4) < 128 } }
  end

  # How it differs from `other`, a raster of its size: the largest difference of a colour channel, and how many pixels
  # differ in any — WPT's maxDifference and totalPixels. Alpha is left out: these are opaque renderings, so an alpha
  # channel one encoding carries and the other does not is no difference. Row by row, the rows alike skipped whole:
  # two renderings differ in a few places, or not at all.
  def difference(other)
    max = pixels = 0
    stride = width * 4
    height.times do |y|
      a, b = rgba.byteslice(y * stride, stride), other.rgba.byteslice(y * stride, stride)
      next if a == b

      p, q = a.unpack('C*'), b.unpack('C*')
      0.step(stride - 1, 4) do |i|
        d = [(p[i] - q[i]).abs, (p[i + 1] - q[i + 1]).abs, (p[i + 2] - q[i + 2]).abs].max
        next if d.zero?

        pixels += 1
        max = d if d > max
      end
    end
    {max_difference: max, differing_pixels: pixels}
  end

  # The per-channel difference from `other` as a PNG: black where they agree.
  def difference_png(other)
    p, q = rgba.unpack('C*'), other.rgba.unpack('C*')
    delta = Array.new(width * height * 3) {|k| (p[(k / 3 * 4) + (k % 3)] - q[(k / 3 * 4) + (k % 3)]).abs }
    Raster.png(width, height, delta.pack('C*'))
  end

  # Whether every pixel is opaque white, as a page's blank canvas is.
  def white?
    rgba.count("^\xFF".b).zero?
  end

  # A PNG of `width` × `height` pixels of `rgb` (three bytes a pixel): its rows unfiltered, deflated in one IDAT.
  def self.png(width, height, rgb)
    rows  = (0...height).map {|y| "\0".b + rgb.byteslice(y * width * 3, width * 3) }.join
    chunk = ->(type, data) { [data.bytesize].pack('N') + type + data + [Zlib.crc32(type + data)].pack('N') }
    "\x89PNG\r\n\x1A\n".b +
      chunk.call('IHDR', [width, height, 8, 2, 0, 0, 0].pack('NNCCCCC')) +
      chunk.call('IDAT', Zlib::Deflate.deflate(rows)) +
      chunk.call('IEND', '')
  end
end
