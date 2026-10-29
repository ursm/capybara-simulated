# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/https_app_host'
require_relative 'support/poll_until'

# A frame's traversal to an entry whose document is gone fetches the entry's URL as a navigation of the frame does (HTML
# "apply the history step": the document re-made by "create navigation params by fetching"): its request a user's — no
# initiator, Sec-Fetch-Site `none` — the Fetch Metadata of an `iframe` navigation, referred as the entry's document's
# request was and a re-post's origin the one it was first sent with (HTML's document state), its redirects followed,
# the entry the URL it lands at — and a redirected one's document made with none of the entry's form state or history
# state; a `blob:` entry's document its blob's, which the window's registry names now, whatever document it left.
RSpec.describe 'a frame traversal request' do
  include PollUntil

  it "sends a navigation's request and follows its redirect", :https do
    seen   = []
    moved  = false
    s = simulated_session(lambda {|env|
      if env['PATH_INFO'].start_with?('/f')
        seen << [env['PATH_INFO'], env['HTTP_SEC_FETCH_SITE'], env['HTTP_SEC_FETCH_MODE'], env['HTTP_SEC_FETCH_DEST'], env['HTTP_REFERER']]
      end
      next [302, {'location' => '/f3'}, []] if env['PATH_INFO'] == '/f1' && moved

      body = env['PATH_INFO'] == '/top' ? '<iframe src="/f1"></iframe>' : "#{env['PATH_INFO']}<input id=i>"
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    s.visit '/top'
    s.execute_script('frames[0].history.replaceState({k: 1}, ""); frames[0].document.getElementById("i").value = "typed"')
    s.execute_script('frames[0].location = "/f2"')
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f2' }
    moved = true
    seen.clear
    s.go_back
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f3' }

    top = 'https://www.example.com/top'
    expect(seen).to eq([['/f1', 'none', 'navigate', 'iframe', top], ['/f3', 'none', 'navigate', 'iframe', top]])
    expect(s.evaluate_script('[frames[0].document.body.textContent, history.length]')).to eq(['/f3', 2])
    expect(s.evaluate_script('[frames[0].document.referrer, frames[0].history.state, frames[0].document.getElementById("i").value]')).to eq([top, nil, ''])
  end

  # …a `src` set to one an entry as `location` set to it is, which the frame goes back past to the one before it.
  it "goes back through a blob: entry its container's src made" do
    s = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/top' ? '<iframe id=f src="/f1"></iframe>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    s.visit '/top'
    s.execute_script(<<~JS)
      f.src = URL.createObjectURL(new Blob(['<!DOCTYPE html><meta charset=utf-8><body>B'], {type: 'text/html'}));
    JS
    poll_until { s.evaluate_script('frames[0].location.protocol') == 'blob:' }
    s.execute_script('frames[0].location = "/f2"')
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f2' }
    expect(s.evaluate_script('history.length')).to eq(3)
    s.go_back
    poll_until { s.evaluate_script('frames[0].location.protocol') == 'blob:' }
    expect(s.evaluate_script('frames[0].document.body.textContent')).to eq('B')
    s.go_back
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/f1' }
    expect(s.evaluate_script('frames[0].document.body.textContent')).to eq('/f1')
  end

  context 'with every host the app' do
    around do |example|
      prev = ENV['CSIM_LOCAL_ALL_HOSTS']
      ENV['CSIM_LOCAL_ALL_HOSTS'] = '1'
      example.run
    ensure
      ENV['CSIM_LOCAL_ALL_HOSTS'] = prev
    end

    it "re-posts with the origin the entry's request was first sent with" do
      posts = []
      hits  = []
      s = simulated_session(lambda {|env|
        hits << env['PATH_INFO']
        posts << env['HTTP_ORIGIN'] if env['REQUEST_METHOD'] == 'POST'
        body = case env['PATH_INFO']
               when '/top' then '<iframe src="/f1"></iframe>'
               when '/f1' then '<form id=p method=post action="/p"><input name=q value=v></form>'
               else env['PATH_INFO']
               end
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      s.visit '/top'
      s.execute_script('frames[0].document.getElementById("p").submit()')
      poll_until { s.evaluate_script('frames[0].location.pathname') == '/p' }
      s.execute_script('frames[0].location = "http://other.example.com/f2"')
      poll_until { hits.include?('/f2') && s.evaluate_script('1') }
      s.go_back
      poll_until { posts.size == 2 }

      expect(posts).to eq(%w[http://www.example.com] * 2)
    end

    it 'makes a blob: entry\'s document of its blob after another origin\'s document' do
      hits = []
      s = simulated_session(lambda {|env|
        hits << env['PATH_INFO']
        body = env['PATH_INFO'] == '/top' ? '<iframe src="/o"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      s.visit '/top'
      s.execute_script(<<~JS)
        window.u = URL.createObjectURL(new Blob(['<!DOCTYPE html><meta charset=utf-8><body>B'], {type: 'text/html'}));
        frames[0].location = u;
      JS
      poll_until { s.evaluate_script('frames[0].location.protocol') == 'blob:' }
      s.execute_script('frames[0].location = "http://other.example.com/x"')
      poll_until { hits.include?('/x') && s.evaluate_script('1') }
      s.go_back
      poll_until { s.evaluate_script('frames[0].location.protocol') == 'blob:' }

      expect(s.evaluate_script('frames[0].document.body?.textContent || ""')).to eq('B')
    end
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
