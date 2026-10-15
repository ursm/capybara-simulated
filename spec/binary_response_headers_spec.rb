# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A Rack app may hand its header values over binary-tagged — a Net::HTTP-backed proxy's (rack-proxy's) always are —
# and they are the wire's bytes all the same: a Location a navigation and a fetch follow, a Last-Modified, a
# Server-Timing the page reads as text, as the same bytes tagged UTF-8 are.
RSpec.describe 'binary-tagged response headers' do
  let(:session) {
    simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/moved' then [302, {'location' => '/to/日'.b}, ['']]
      when '/timed' then [200, {'content-type' => 'text/plain', 'server-timing' => 'db;dur=53'.b}, ['x']]
      else [200, {'content-type' => 'text/html', 'last-modified' => 'Wed, 21 Oct 2015 07:28:00 GMT'.b}, ['<!DOCTYPE html><body>']]
      end
    })
  }

  it 'follows a Location, and reads a Last-Modified and a Server-Timing' do
    session.visit '/moved'
    session.execute_script(<<~JS)
      Promise.all([fetch('/moved'), fetch('/timed').then(r => r.text())]).then(([moved]) => {
        const timing = performance.getEntriesByName(new URL('/timed', location.href).href)[0].serverTiming[0];
        globalThis.__got = [moved.url, timing.name, timing.duration];
      });
    JS
    poll_until { session.evaluate_script('!!globalThis.__got') }

    expect(session.current_url).to eq('http://www.example.com/to/%E6%97%A5')
    expect(session.evaluate_script('new Date(document.lastModified).getTime()')).to eq(Time.utc(2015, 10, 21, 7, 28).to_i * 1000)
    expect(session.evaluate_script('globalThis.__got')).to eq(['http://www.example.com/to/%E6%97%A5', 'db', 53])
  end

  # …and one that is no UTF-8 — a Latin-1 byte, binary-tagged or tagged UTF-8 all the same — is still a response: its
  # cookie stored, its Location followed (a byte past ASCII percent-encoded as itself, Chrome's), the app's own header hash left as it was.
  [:binary, :utf8].each do |tag|
    it "takes a #{tag}-tagged header with a Latin-1 byte as bytes" do
      bytes  = ->(v) { tag == :binary ? v.b : v.dup.force_encoding(Encoding::UTF_8) }
      shared = {'content-type' => 'text/html', 'x-shared' => bytes.("caf\xE9".b)}.freeze
      headers = {
        'set-cookie' => bytes.("c=caf\xE9; path=/".b), 'content-disposition' => bytes.("inline; filename=caf\xE9.txt".b),
        'last-modified' => bytes.("Wed, 21 Oct 2015 07:28:00 GMT\xE9".b), 'cache-control' => bytes.("max-age=60, x=\xE9".b)
      }
      s = simulated_session(lambda {|env|
        case env['PATH_INFO']
        when '/moved' then [302, {'location' => bytes.("/to/\xE9".b)}, ['']]
        when '/page' then [200, shared.merge(headers), ['<!DOCTYPE html><body>']]
        else [200, shared, ['<!DOCTYPE html><body>']]
        end
      })
      s.visit '/page'
      got = s.evaluate_script(<<~JS)
        (() => { const x = new XMLHttpRequest(); x.open('GET', '/page', false); x.send(); return [x.status, x.getResponseHeader('x-shared')]; })()
      JS
      s.visit '/moved'

      expect(got).to eq([200, "caf\u00E9"])
      expect(s.current_url).to eq('http://www.example.com/to/%E9')
      expect(shared['x-shared'].encoding).to eq(tag == :binary ? Encoding::BINARY : Encoding::UTF_8)
    end
  end
end
