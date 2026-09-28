# frozen_string_literal: true

require 'capybara/simulated'
require 'base64'
require 'vips'
require_relative 'support/session_teardown'

# A canvas's pixels reach the host encoder through the transfer-buffer registry, which stores what
# it is handed as a binary String. A payload that crossed in any other shape would be encoded as
# its text — once, every `toDataURL` / `toBlob` produced a picture of `{"0" => 0, "1" => …`. A
# known colour read back out of the PNG is what catches that.
RSpec.describe 'canvas encoding' do
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

  # A one-row canvas of an odd width: 3x1 is 12 bytes and 2x1 is 8, where the 4x4 above is 64 —
  # neither a square nor a whole number of base64 groups. The pixels cross the stash as ONE binary
  # String of exactly w*h*4 bytes, and the encoder reads it as rows of `w`; a length or stride slip
  # anywhere on that hop shows up as the wrong size or the wrong colour.
  [[3, 1], [2, 1]].each do |w, h|
    it "round-trips a #{w}x#{h} canvas (#{w * h * 4} bytes of pixels)" do
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] })
      s.visit '/'
      url = s.evaluate_script(<<~JS)
        (() => {
          const c = document.createElement('canvas');
          c.width = #{w}; c.height = #{h};
          const g = c.getContext('2d');
          g.fillStyle = 'rgb(255, 128, 0)';
          g.fillRect(0, 0, #{w}, #{h});
          return c.toDataURL('image/png');
        })()
      JS
      path = File.join(Dir.tmpdir, "csim-canvas-#{Process.pid}-#{rand(1 << 32)}.png")
      File.binwrite(path, Base64.decode64(url.delete_prefix('data:image/png;base64,')))
      img = Vips::Image.new_from_file(path)
      expect([img.width, img.height]).to eq([w, h])
      expect(img.getpoint(w - 1, 0).map(&:to_i)[0, 3]).to eq([255, 128, 0])
    ensure
      File.delete(path) if path && File.exist?(path)
    end
  end
end
