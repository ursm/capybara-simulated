# frozen_string_literal: true

require 'capybara/simulated'
require 'base64'
require 'vips'
require_relative 'support/session_teardown'

# A canvas's pixels reach the host encoder through the transfer-buffer registry, and what a typed
# array LOOKS like on this side depends on the JS engine: rusty_racer marshals it as a binary
# String, quickjs as a Hash of "index" => byte. The registry used to `to_s` whatever it got, so
# under QuickJS it stored that Hash's inspect text and encoded those characters as the image —
# every `toDataURL` / `toBlob` produced a picture of `{"0" => 0, "1" => …`. It runs under whichever
# engine the suite is using, which is the point: this only ever failed on one of them.
RSpec.describe 'canvas encoding across engines' do
  it 'round-trips a known colour through toDataURL' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
    s.visit '/'
    url = s.evaluate_script(<<~JS)
      (() => {
        const c = document.createElement('canvas');
        c.width = 4; c.height = 4;
        const g = c.getContext('2d');
        g.fillStyle = 'rgb(0, 0, 255)';
        g.fillRect(0, 0, 4, 4);
        return c.toDataURL('image/png');
      })()
    JS
    expect(url).to start_with('data:image/png;base64,')

    path = File.join(Dir.tmpdir, "csim-canvas-#{Process.pid}-#{rand(1 << 32)}.png")
    File.binwrite(path, Base64.decode64(url.delete_prefix('data:image/png;base64,')))
    img = Vips::Image.new_from_file(path)
    expect([img.width, img.height]).to eq([4, 4])
    expect(img.getpoint(1, 1).map(&:to_i)[0, 3]).to eq([0, 0, 255])
  ensure
    File.delete(path) if path && File.exist?(path)
  end
end
