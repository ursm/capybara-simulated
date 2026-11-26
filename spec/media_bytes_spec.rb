require_relative 'spec_helper'
require 'zlib'
require_relative 'support/session_teardown'
require_relative 'support/engine_global'

# A `<video src>` served over http reaches the decoder as its raw bytes: the host fetch
# (`mediaBytes`, on the realm's host object: `RustyRacer.host` in a spec's realm) hands JS a
# BINARY String, which crosses as a Uint8Array. The fetched body is not always BINARY-tagged on
# the Ruby side — undoing a Content-Encoding tags it UTF-8, and so may an app — and a
# UTF-8-tagged String crosses as TEXT, where bytes that are not valid UTF-8 raise. Both shapes
# must arrive as the same five bytes.
RSpec.describe 'media bytes across the host boundary', :engine_global do
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
          const r = RustyRacer.host.mediaBytes(new URL('#{path}', location.href).href);
          return r && r.bytes instanceof Uint8Array ? Array.from(r.bytes) : null;
        })()
      JS
      expect(got).to eq(bytes.bytes)
    end
  end
end
