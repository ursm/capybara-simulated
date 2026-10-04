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

  # Chrome's answers (measured): `image/jpg` names no format, so it is PNG; the type is matched case-insensitively; a
  # JPEG has no alpha, so a half-transparent red is composited onto black. A bitmap with no pixels serialises to
  # nothing: toBlob calls back with null, convertToBlob rejects with an IndexSizeError (HTML §4.12.5.1, §4.12.5.3).
  it 'writes the format the type names, a JPEG onto black, and nothing for a bitmap with no pixels' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body></body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(255, 0, 0, 0.5)';
      g.fillRect(0, 0, 1, 1);
      const r = ['image/jpg', 'IMAGE/JPEG', 'image/webp', 'image/bmp'].map(t => c.toDataURL(t).slice(5, 15));
      const img = new Image();
      img.onload = () => {
        const d = document.createElement('canvas').getContext('2d');
        d.drawImage(img, 0, 0);
        r.push(Array.from(d.getImageData(0, 0, 1, 1).data));
        const empty = document.createElement('canvas');
        empty.width = 0;
        empty.toBlob(b => {
          r.push(b);
          new OffscreenCanvas(0, 1).convertToBlob().then(() => done(r), e => done(r.concat(e.name)));
        });
      };
      img.src = c.toDataURL('image/jpeg', 1);
    JS
    expect(got[0, 4]).to eq(%w[image/png; image/jpeg image/webp image/png;])
    expect(got[4][0]).to be_within(2).of(128)
    expect(got[4][1..]).to eq([0, 0, 255])
    expect(got[5..]).to eq([nil, 'IndexSizeError'])
  end

  # Chrome's answers (measured), where the spec does not leave them open: toBlob serialises the bitmap as it is at the
  # call (a copy, §4.12.5.1 step 3) and calls back once, an exception it throws reported rather than answered with a
  # second, null, call; convertToBlob converts its ImageEncodeOptions first (quality, then type; a quality string is a
  # number) and rejects a tainted bitmap before one with no pixels. And by the spec: convertToBlob's options are a
  # dictionary (a number is a TypeError) and it settles in a task (§4.12.5.3), not a microtask later; a Display P3
  # canvas's PNG carries its profile (§4.12.5.5).
  it 'serialises the bitmap at the call, calls back once, and converts convertToBlob options as WebIDL does' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body></body>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0], r = [];
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d');
      g.fillStyle = 'red';
      g.fillRect(0, 0, 1, 1);
      let calls = 0;
      window.onerror = () => { r.push('reported'); return true; };
      c.toBlob(b => {
        calls++;
        createImageBitmap(b).then(bm => {
          const d = document.createElement('canvas').getContext('2d');
          d.drawImage(bm, 0, 0);
          r.push(Array.from(d.getImageData(0, 0, 1, 1).data), calls);
          const read = [];
          const opts = { get quality() { read.push('quality'); return '0.05'; }, get type() { read.push('type'); return 'image/jpeg'; } };
          const o = new OffscreenCanvas(0, 0);
          o.convertToBlob(opts).catch(e => {
            r.push(read.join(','), e.name);
            return new OffscreenCanvas(1, 1).convertToBlob(5);
          }).catch(e => {
            r.push(e.name);
            let settled = false;
            const blob = new OffscreenCanvas(1, 1).convertToBlob().then(() => { settled = true; });
            return Promise.resolve().then(() => Promise.resolve()).then(() => r.push(settled)).then(() => blob);
          }).then(() => {
            const p3 = document.createElement('canvas');
            p3.width = p3.height = 1;
            p3.getContext('2d', {colorSpace: 'display-p3'}).fillRect(0, 0, 1, 1);
            r.push(p3.toDataURL());
            done(r);
          });
        });
        throw new Error('in the callback');
      });
      g.clearRect(0, 0, 1, 1);
    JS
    expect(got[0..-2]).to eq(['reported', [255, 0, 0, 255], 1, 'quality,type', 'IndexSizeError', 'TypeError', false])
    # (…a profile libpng keeps: one whose length is not a whole number of words it drops, with a warning)
    png = Vips::Image.new_from_buffer(Base64.decode64(got.last.delete_prefix('data:image/png;base64,')), '')
    expect(png.get_fields).to include('icc-profile-data')
  end
end
