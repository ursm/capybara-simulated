# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's referrer is the Referer its navigation's request sent (HTML §3.1.2 `document.referrer`): the document
# that navigated to it under its referrer policy — a frame's as the page's, a POST's as a GET's — and the empty string
# for a document no navigation that sent one made.
RSpec.describe 'document.referrer' do
  let(:session) do
    simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/top' then '<iframe src="/f"></iframe><a id=l target=n href="/g">l</a><iframe name=n src="/h"></iframe>' \
                              '<form id=p method=post action="/posted"></form>'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
  end

  it "is a frame's navigation's" do
    session.visit '/top'
    expect(session.evaluate_script('[frames[0].document.referrer, frames[1].document.referrer]')).to eq(%w[http://www.example.com/top http://www.example.com/top])
    # (…the document whose script navigates it: the frame's own, then the page's)
    session.execute_script(%q{frames[0].eval('location = "/f2"')})
    expect(session.evaluate_script('frames[0].document.referrer')).to eq('http://www.example.com/f')
    session.execute_script('frames[0].location = "/f3"')
    expect(session.evaluate_script('frames[0].document.referrer')).to eq('http://www.example.com/top')
    session.execute_script('l.click()')
    expect(session.evaluate_script('frames[1].location.pathname')).to eq('/g')
    expect(session.evaluate_script('frames[1].document.referrer')).to eq('http://www.example.com/top')
  end

  # …its last hop's, a redirect's `Referrer-Policy` the next hop's policy and the Referer each hop sent its referrer
  # (Fetch "HTTP-redirect fetch": "set request's referrer policy to the result of parsing" it; "main fetch": the request's
  # referrer the one determined) — a frame's navigation's as a fetch's.
  it "is a redirected frame navigation's, narrowed by the redirect's referrer policy" do
    referers = {}
    s = simulated_session(lambda {|env|
      referers[env['PATH_INFO']] = env['HTTP_REFERER']
      next [302, {'location' => '/final', 'referrer-policy' => 'origin'}, []] if env['PATH_INFO'] == '/redir'

      body = env['PATH_INFO'] == '/top' ? '<iframe src="/redir"></iframe>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    s.visit '/top'

    expect(referers.values_at('/redir', '/final')).to eq(%w[http://www.example.com/top http://www.example.com/])
    expect(s.evaluate_script('frames[0].document.referrer')).to eq('http://www.example.com/')
  end

  # …the page's as a frame's, its GET and its POST alike — a fragment the redirect names none of carried over to the
  # URL it lands at (Fetch "HTTP-redirect fetch").
  %w[get post].each do |method|
    it "is a redirected page #{method.upcase} navigation's, narrowed by the redirect's referrer policy" do
      referers = {}
      s = simulated_session(lambda {|env|
        referers[env['PATH_INFO']] = env['HTTP_REFERER']
        next [302, {'location' => '/final', 'referrer-policy' => 'origin'}, []] if env['PATH_INFO'] == '/redir'

        body = env['PATH_INFO'] == '/top' ? "<form id=p method=#{method} action='/redir#f'></form>" : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      s.visit '/top'
      s.execute_script('p.submit()')

      expect(s).to have_current_path('/final')
      expect(referers.values_at('/redir', '/final')).to eq(%w[http://www.example.com/top http://www.example.com/])
      expect(s.evaluate_script('[document.referrer, location.hash]')).to eq(%w[http://www.example.com/ #f])
    end
  end

  it "is a POST navigation's" do
    session.visit '/top'
    session.execute_script('p.submit()')
    expect(session).to have_current_path('/posted')
    expect(session.evaluate_script('document.referrer')).to eq('http://www.example.com/top')
  end

  # …an XHTML document's as an HTML one's.
  it "is an XHTML document's" do
    session = simulated_session(lambda {|env|
      next [200, {'content-type' => 'application/xhtml+xml'}, ['<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>']] if env['PATH_INFO'] == '/x.xhtml'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><a href="/x.xhtml">x</a>']]
    })
    session.visit '/src'
    session.click_link 'x'
    expect(session.evaluate_script('document.referrer')).to eq('http://www.example.com/src')
  end

  # …a page form's navigation of a named frame's, its policy the frame's container's `referrerpolicy` or its document's.
  it "is a named frame's form navigation's" do
    session.visit '/top'
    session.execute_script('const f = document.createElement("form"); f.method = "post"; f.target = "n"; f.action = "/posted"; document.body.append(f); f.submit()')
    session.evaluate_script('1')
    expect(session.evaluate_script('[frames[1].location.pathname, frames[1].document.referrer]')).to eq(%w[/posted http://www.example.com/top])
  end

  {
    '<iframe referrerpolicy=no-referrer src="/k"></iframe>' => '',
    '<iframe referrerpolicy=origin src="/k"></iframe>' => 'http://www.example.com/',
    '<meta name=referrer content=no-referrer><iframe src="/k"></iframe>' => ''
  }.each do |markup, referrer|
    it "is a frame's under its policy: #{markup}" do
      session = simulated_session(lambda {|env|
        body = env['PATH_INFO'] == '/rp' ? markup : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      session.visit '/rp'
      expect(session.evaluate_script('frames[0].document.referrer')).to eq(referrer)
    end
  end

  # A reload or a traversal makes the document with its document state's referrer (HTML): the page's and a frame's —
  # the frame's the page's, whose script navigated it (the Location-object navigation's source document, its incumbent).
  it "is kept by a frame's traversal" do
    session.visit '/top'
    session.execute_script('frames[0].location = "/f2"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f2')
    session.execute_script('frames[0].location = "/f3"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f3')
    session.go_back
    expect(session.evaluate_script('[frames[0].location.pathname, frames[0].document.referrer]')).to eq(%w[/f2 http://www.example.com/top])
  end

  it "is kept by the page's traversal" do
    session.visit '/top'
    session.execute_script('location.href = "/c"')
    expect(session).to have_current_path('/c')
    session.execute_script('location.href = "/d"')
    expect(session).to have_current_path('/d')
    session.go_back
    expect(session.evaluate_script('[location.pathname, document.referrer]')).to eq(%w[/c http://www.example.com/top])
  end

  # …but a reload refers by the document reloading (Chrome, measured: `location.reload()` sends the page's own URL).
  it 'is the reloading document for a reload' do
    session.visit '/top'
    session.execute_script('location.href = "/c"')
    expect(session).to have_current_path('/c')
    session.execute_script('location.reload()')
    session.evaluate_script('1')
    expect(session.evaluate_script('document.referrer')).to eq('http://www.example.com/c')
  end

  it "is the reloading frame document for a frame's reload" do
    session.visit '/top'
    session.execute_script('frames[0].location.reload()')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].document.referrer')).to eq('http://www.example.com/f')
    session.execute_script('frames[0].location = "/f2"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/f2')
    session.execute_script('frames[0].location.reload()')
    session.evaluate_script('1')
    expect(session.evaluate_script('frames[0].document.referrer')).to eq('http://www.example.com/f2')
  end

  # A hyperlink with `noreferrer` sends none (HTML "follow the hyperlink"), in its own window as in another.
  it 'is none for a noreferrer link' do
    session = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/s' ? '<a rel=noreferrer href="/c">c</a>' : env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/s'
    session.click_link 'c'
    expect(session.evaluate_script('document.referrer')).to eq('')
  end

  # An initial about:blank document's is its creator's URL (HTML "create a new browsing context and document"): a
  # frame with no `src`, a window `window.open` made with no URL.
  it "is an initial about:blank document's creator's URL" do
    session.visit '/top'
    session.execute_script('document.body.append(document.createElement("iframe")); window.w = open("")')
    expect(session.evaluate_script('[frames[2].document.referrer, w.document.referrer]')).to eq(%w[http://www.example.com/top http://www.example.com/top])
  end

  it 'is none for a visit' do
    session.visit '/top'
    expect(session.evaluate_script('document.referrer')).to eq('')
  end
end
