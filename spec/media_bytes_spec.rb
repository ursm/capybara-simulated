require_relative 'spec_helper'
require 'zlib'
require_relative 'support/session_teardown'

# A `<video src>` served over http reaches the ffmpeg decoder as its raw bytes: the host fetch
# (`__csim_videoBytes`) hands JS a BINARY String, which crosses as a Uint8Array. The fetched
# body is not always BINARY-tagged on the Ruby side — undoing a Content-Encoding tags it UTF-8,
# and so may an app — and a UTF-8-tagged String crosses as TEXT, where bytes that are not
# valid UTF-8 raise. Both shapes must arrive as the same five bytes.
RSpec.describe 'media bytes across the host boundary' do
  let(:bytes) { "\x00\xff\x80ab".b }

  let(:app) {
    media = bytes
    lambda {|env|
      case env['PATH_INFO']
      when '/plain' then [200, {'content-type' => 'video/mp4'}, [media]]
      when '/gzip'  then [200, {'content-type' => 'video/mp4', 'content-encoding' => 'gzip'}, [Zlib.gzip(media)]]
      when '/utf8'  then [200, {'content-type' => 'video/mp4'}, [media.dup.force_encoding('UTF-8')]]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']]
      end
    }
  }

  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  %w[/plain /gzip /utf8].each do |path|
    it "carries #{path} as a Uint8Array of the body's bytes" do
      got = session.evaluate_script(<<~JS)
        (() => {
          const r = __csim_videoBytes(new URL('#{path}', location.href).href);
          return r && r.bytes instanceof Uint8Array ? Array.from(r.bytes) : null;
        })()
      JS
      expect(got).to eq(bytes.bytes)
    end
  end
end
