# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A `<video>`'s first frame decoded natively (csim_native's video.rs): MP4 and WebM, H.264, VP8 and VP9 — WPT's own
# fixtures, each a known colour — its size and duration; a codec we do not decode (HEVC) fails the load with a
# MediaError, and canPlayType says what we can play.
RSpec.describe 'video decode' do
  wpt = File.join(__dir__, 'wpt')
  let(:app) {
    lambda {|env|
      path = env['PATH_INFO']
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] if path == '/'
      [200, {'content-type' => path.end_with?('.webm') ? 'video/webm' : 'video/mp4'}, [File.binread(File.join(wpt, path))]]
    }
  }

  it 'draws the first frame of each codec, and fails a codec it does not decode' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const srcs = ['/media/2x2-green.mp4', '/media/2x2-green.webm', '/media/movie_5.webm', '/media/white.webm',
                    '/html/canvas/element/manual/wide-gamut-canvas/resources/Rec2020-3FF000000.mp4'];
      Promise.all(srcs.map(src => new Promise(resolve => {
        const v = document.createElement('video');
        v.oncanplaythrough = () => {
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          const g = c.getContext('2d');
          g.drawImage(v, 0, 0);
          resolve([src, [v.videoWidth, v.videoHeight, Math.round(v.duration), Array.from(g.getImageData(0, 0, 1, 1).data)]]);
        };
        v.onerror = () => resolve([src, [v.error.code, v.error instanceof MediaError]]);
        v.src = src;
      }))).then(r => done(Object.fromEntries(r)));
    JS
    green = ->(px) { px[0] < 60 && px[1] > 100 && px[2] < 60 }
    expect(got['/media/2x2-green.mp4'][0..1]).to eq([2, 2])
    expect(got['/media/2x2-green.mp4'][3]).to satisfy(&green)
    expect(got['/media/2x2-green.webm'][3]).to satisfy(&green)
    expect(got['/media/movie_5.webm'][0..2]).to eq([320, 240, 5])
    expect(got['/media/white.webm'][3]).to eq([255, 255, 255, 255])
    expect(got['/html/canvas/element/manual/wide-gamut-canvas/resources/Rec2020-3FF000000.mp4']).to eq([4, true])
  end

  # Chrome's answers but one (measured): it says 'maybe' to `video/ogg`, which it plays; we decode no Theora, and the
  # spec's answer for a type the UA knows it cannot render is ''.
  it 'answers canPlayType by what it decodes' do
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const v = document.createElement('video');
        return ['video/mp4', 'video/webm; codecs="vp9"', 'video/webm; codecs="vp9, opus"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
                'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/ogg', 'video/quicktime'].map(t => v.canPlayType(t));
      })()
    JS
    expect(got).to eq(['maybe', 'probably', 'probably', 'probably', '', '', ''])
  end
end
