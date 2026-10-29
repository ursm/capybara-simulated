# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/https_app_host'
require_relative 'support/poll_until'

# A frame's traversal to an entry whose document is gone fetches the entry's URL as a navigation of the frame does (HTML
# "apply the history step": the document re-made by "create navigation params by fetching"): its request a user's — no
# initiator, Sec-Fetch-Site `none` — the Fetch Metadata of an `iframe` navigation, its redirects followed, the entry the
# URL it lands at; a `blob:` entry's document its blob's, which the window's registry names now.
RSpec.describe 'a frame traversal request' do
  include PollUntil

  it "sends a navigation's request and follows its redirect", :https do
    seen   = []
    moved  = false
    s = simulated_session(lambda {|env|
      seen << [env['PATH_INFO'], env['HTTP_SEC_FETCH_SITE'], env['HTTP_SEC_FETCH_MODE'], env['HTTP_SEC_FETCH_DEST']] if env['PATH_INFO'].start_with?('/f')
      next [302, {'location' => '/f3'}, []] if env['PATH_INFO'] == '/f1' && moved

      body = env['PATH_INFO'] == '/top' ? '<iframe src="/f1"></iframe>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    s.visit '/top'
    s.execute_script('frames[0].location = "/f2"')
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f2' }
    moved = true
    seen.clear
    s.go_back
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f3' }

    expect(seen).to eq([%w[/f1 none navigate iframe], %w[/f3 none navigate iframe]])
    expect(s.evaluate_script('[frames[0].document.body.textContent, history.length]')).to eq(['/f3', 2])
  end

  [false, true].each do |revoked|
    it "makes a blob: entry's document of its blob#{', a revoked one an error document' if revoked}" do
      s = simulated_session(lambda {|env|
        body = env['PATH_INFO'] == '/top' ? '<iframe src="/o"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      s.visit '/top'
      s.execute_script(<<~JS)
        window.u = URL.createObjectURL(new Blob(['<!DOCTYPE html><meta charset=utf-8><body>B'], {type: 'text/html'}));
        frames[0].location = u;
      JS
      poll_until { s.evaluate_script('frames[0].location.protocol') == 'blob:' }
      s.execute_script('frames[0].location = "/a"')
      poll_until { s.evaluate_script('frames[0].location.pathname') == '/a' }
      s.execute_script('URL.revokeObjectURL(u)') if revoked
      s.go_back
      poll_until { s.evaluate_script('frames[0].location.protocol') == 'blob:' }

      expect(s.evaluate_script('frames[0].document.body?.textContent || ""')).to eq(revoked ? '' : 'B')
    end
  end
end
