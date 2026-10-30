# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'
require_relative 'support/every_host_local'

# A session's cookies are its cookie store's, the engine's (cookie_jar.rs), as RFC 6265bis has a user agent keep them: a
# cookie set with a Domain goes to every host that domain-matches it — a public suffix none — one set with a Path only to
# the paths under it, an HttpOnly one to no `document.cookie`, an expired one nowhere, and a `__Host-` one only where it
# is Secure, host-only and at `/`. (They had been a name → value table per host, which read none of these.)
RSpec.describe 'the cookie store' do
  include PollUntil

  let(:seen) { [] }
  let(:app) {
    seen = self.seen
    lambda {|env|
      req = Rack::Request.new(env)
      seen << [req.host, req.path, env['HTTP_COOKIE'].to_s]
      case req.path
      when '/sandboxed-worker'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe sandbox="allow-scripts" srcdoc="<script>const w = new Worker(\'http://www.example.com/w.js\'); w.onerror = () => parent.postMessage(\'error\', \'*\');</script>"></iframe><script>window.onmessage = (e) => { window.got = e.data; };</script>']]
      when '/w.js'
        [200, {'content-type' => 'text/javascript'}, ['']]
      when '/sandboxed'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe sandbox="allow-scripts" srcdoc="<script>try { document.cookie; parent.postMessage(\'read\', \'*\'); } catch (e) { parent.postMessage(e.name, \'*\'); }</script>"></iframe><script>window.onmessage = (e) => { window.got = e.data; };</script>']]
      when '/set'
        [200, {'content-type' => 'text/html', 'set-cookie' => [
          'shared=1; Domain=example.com; Path=/',
          'here=2; Path=/',
          'deep=3; Path=/app',
          'secret=4; HttpOnly; Path=/',
          'gone=5; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
          'suffix=6; Domain=com; Path=/',
          '__Host-bad=7; Path=/'
        ]}, ['<!DOCTYPE html><body>set']]
      else
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>page']]
      end
    }
  }

  it 'sends each cookie where its attributes scope it' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/set'
    s.visit 'http://www.example.com/app/page'
    s.visit 'http://www.example.com/other'
    s.visit 'http://api.example.com/'
    expect(seen.drop(1)).to eq([
      ['www.example.com', '/app/page', 'deep=3; shared=1; here=2; secret=4'],
      ['www.example.com', '/other', 'shared=1; here=2; secret=4'],
      ['api.example.com', '/', 'shared=1']
    ])
  end

  it 'hides an HttpOnly cookie from document.cookie, which may not overwrite it' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/set'
    expect(s.evaluate_script('document.cookie')).to eq('shared=1; here=2')
    s.execute_script("document.cookie = 'secret=x'; document.cookie = 'js=8'")
    s.visit 'http://www.example.com/other'
    expect(seen.last).to eq(['www.example.com', '/other', 'shared=1; here=2; secret=4; js=8'])
  end

  # A document of an opaque origin has no cookies: a SecurityError (HTML, Chrome).
  it 'refuses a sandboxed document its cookies' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/sandboxed'
    expect(s.evaluate_script('window.got')).to eq('SecurityError')
  end

  # A load the host makes for a document — an image's, and a fetch() — is cross-site for cookies where its document is,
  # or the top-level one, or a `data:` one it is in, and stays so across its redirects to that site, one the HTTP cache
  # answers too: no Strict or Lax cookie goes (Chrome measured) — a cross-site frame's fetch() back to its own site
  # included, a keepalive one's and a dedicated worker's it made too, the worker's keepalive one included.
  it "sends a cross-site document's image loads no SameSite cookie" do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      seen << [req.path, env['HTTP_COOKIE'].to_s] if req.path.start_with?('/echo')
      case req.path
      when '/set'   then [200, {'content-type' => 'text/plain', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/fetcher' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><script>fetch("http://b.test/echo-fetch"); fetch("http://b.test/echo-keepalive", {keepalive: true}); new Worker("/w.js")</script>']]
      when '/w.js'    then [200, {'content-type' => 'text/javascript'}, ['fetch("http://b.test/echo-worker"); fetch("http://b.test/echo-wkeep", {keepalive: true})']]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><img src="http://a.test/echo-frame"><img src="http://a.test/r301">']]
      when '/r301'  then [301, {'location' => 'http://a.test/echo-redirect', 'cache-control' => 'max-age=3600'}, ['']]
      when '/top'   then [200, {'content-type' => 'text/html'}, [
        '<!DOCTYPE html><iframe src="http://b.test/frame"></iframe>' \
        '<iframe src="data:text/html,<img src=http://a.test/echo-data>"></iframe>' \
        '<iframe src="http://b.test/fetcher"></iframe>'
      ]]
      else [200, {'content-type' => 'image/gif'}, ['GIF89a']]
      end
    }
    # (…every host the app's, so the cross-site frame is built as the page loads)
    s = every_host_local { simulated_session(app) }
    s.visit 'http://a.test/set'
    s.visit 'http://b.test/set'
    2.times { s.visit 'http://a.test/top' }
    # (…the worker's fetches on its own thread, in real time: waited for, a bounded while, rather than raced)
    50.times do
      break if (%w[/echo-worker /echo-wkeep] - seen.map(&:first)).empty?

      sleep 0.1
    end
    expect(seen.map(&:first).uniq.sort).to eq(%w[/echo-data /echo-fetch /echo-frame /echo-keepalive /echo-redirect /echo-wkeep /echo-worker])
    expect(seen.reject {|_, c| c.empty? }).to eq([])
  end

  # Fetch's "determine the same-site mode": "If request's redirect-taint is 'cross-site', then return 'unset-or-less'",
  # and a request's redirect-taint is "cross-site" once a URL of its URL list "is not same site with lastURL's origin and
  # request's origin is not same site with lastURL's origin". So a request a page makes through another site and back
  # to its own is cross-site at home — no SameSite cookie for its image (one the HTTP cache's redirect answers too) or
  # its fetch(), the Lax one alone for its top-level navigation (a GET of a document) — as one another site's page makes
  # there is; a user's, of no initiating document, is untainted. Sec-Fetch-Site, which Fetch Metadata judges over the
  # whole URL list, is `cross-site` alike. Firefox 159 sends these cookies as this does (measured 2026-10-31, over http:
  # an image, a no-cors fetch() and a script's navigation, a→b→a and b→b→a); Chrome 156 sends a→b→a's every one, Strict
  # included, as RFC 6265bis-14 (A.14, httpwg/http-extensions#2750) dropped its own redirect-chain rule.
  it 'taints a request redirected through another site cross-site' do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'    then [200, {'content-type' => 'text/html', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/bounce' then [302, {'location' => req.params['to'], 'cache-control' => 'max-age=3600'}, ['']]
      when '/page'
        home   = "https://a.test/echo-#{req.host[0]}"
        bounce = lambda {|kind| "https://b.test/bounce?to=#{Rack::Utils.escape("#{home}-#{kind}")}" }
        [200, {'content-type' => 'text/html'}, [
          "<!DOCTYPE html><img src=\"#{bounce.('img')}\"><a href=\"#{bounce.('nav')}\">go</a>" \
          "<script>fetch(#{bounce.('fetch').to_json}, {mode: 'no-cors', credentials: 'include'})</script>"
        ]]
      else
        seen << [req.path, env['HTTP_COOKIE'].to_s, env['HTTP_SEC_FETCH_SITE']] if req.path.start_with?('/echo')
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>home']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'https://a.test/set'
    %w[a b].each do |host|
      2.times do
        s.visit "https://#{host}.test/page"
        poll_until { seen.map(&:first).include?("/echo-#{host}-fetch") }
      end
      s.click_link 'go'
    end
    s.visit 'https://b.test/bounce?to=https://a.test/echo-user'
    expect(seen.uniq.sort).to eq([
      ['/echo-a-fetch', '', 'cross-site'],
      ['/echo-a-img', '', 'cross-site'],
      ['/echo-a-nav', 'l=1', 'cross-site'],
      ['/echo-b-fetch', '', 'cross-site'],
      ['/echo-b-img', '', 'cross-site'],
      ['/echo-b-nav', 'l=1', 'cross-site'],
      ['/echo-user', 's=1; l=1', 'none']
    ])
  end

  # A top-level navigation is judged by its initiator's ORIGIN, not by the documents above it: Fetch's "determine the
  # same-site mode" — "If request's top-level navigation initiator origin is non-null and is not same site with
  # request's URL's origin, then return 'unset-or-less'" — and Chrome 156 and Firefox 159 alike (measured 2026-10-31: a
  # popup a's frame under b's page opens to a gets the Strict cookie in both). So a frame of a's navigating the top to a
  # sends the Strict cookie whether a's page or b's is above it — though RFC 6265bis §5.2.1 would give it, under b's,
  # an opaque "site for cookies".
  it "judges a navigation by its initiator's origin" do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'   then [200, {'content-type' => 'text/html', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/top'   then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><iframe src="https://a.test/frame"></iframe>']]
      when '/frame' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><a href="https://a.test/echo" target="_top">go</a>']]
      else
        seen << [req.referer.to_s[%r{//([^/]+)}, 1], env['HTTP_COOKIE'].to_s]
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>home']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'https://a.test/set'
    %w[a b].each do |host|
      s.visit "https://#{host}.test/top"
      s.within_frame(0) { s.click_link 'go' }
      poll_until { seen.size == %w[a b].index(host) + 1 }
    end
    expect(seen).to eq([['a.test', 's=1; l=1'], ['a.test', 's=1; l=1']])
  end

  # …and a navigation another window's script planned (session_history.rs `Planned`) by its initiator alike: a
  # sandboxed page's — of an opaque origin, of no site — cross-site to its own host, its Strict cookie not sent and its
  # Sec-Fetch-Site `cross-site`, a GET's as a POST's.
  it "judges a navigation a sandboxed page planned of another window as of no site" do
    seen = {}
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'   then [200, {'content-type' => 'text/html', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/boxed' then [200, {'content-type' => 'text/html', 'content-security-policy' => 'sandbox allow-scripts allow-popups'}, ['<!DOCTYPE html>boxed']]
      else
        seen[req.path] = [env['HTTP_COOKIE'].to_s, env['HTTP_SEC_FETCH_SITE']]
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>home']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'https://a.test/set'
    s.visit 'https://a.test/mine'
    s.visit 'https://a.test/boxed'
    popup = s.window_opened_by { s.execute_script("open('https://a.test/planned', 'w')") }
    s.within_window(popup) { poll_until { seen.key?('/planned') } }
    expect(seen).to eq('/mine' => ['s=1; l=1', 'none'], '/planned' => ['l=1', 'cross-site'])
  end

  # …and by the document that planned it, the frame whose script ran `window.open` or set `w.location` — not its window's
  # page: a frame of a's under b's page navigating another window to a is same-origin to it, its Strict cookie sent (the
  # initiator's origin, as above: Chrome 156 and Firefox 159 measured), and a frame of b's under a's page cross-site to
  # a for Fetch Metadata and cookies alike.
  it 'judges a navigation a frame planned of another window by that frame' do
    seen = {}
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'    then [200, {'content-type' => 'text/html', 'set-cookie' => ['s=1; SameSite=Strict; Path=/', 'l=1; SameSite=Lax; Path=/']}, ['set']]
      when '/top'    then [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><iframe src=\"#{req.params['frame']}\"></iframe>"]]
      when '/opens'  then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><script>open("https://a.test/echo-open", "w1")</script>']]
      when '/sets'   then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><script>open("", "w1").location = "https://a.test/echo-set"</script>']]
      else
        seen[req.path] = [env['HTTP_COOKIE'].to_s, env['HTTP_SEC_FETCH_SITE']] if req.path.start_with?('/echo')
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>home']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'https://a.test/set'
    first = s.window_opened_by { s.visit 'https://b.test/top?frame=https://a.test/opens' }
    s.within_window(first) { poll_until { seen.key?('/echo-open') } }
    s.visit 'https://a.test/top?frame=https://b.test/sets'
    s.within_window(first) { poll_until { seen.key?('/echo-set') } }
    expect(seen).to eq('/echo-open' => ['s=1; l=1', 'same-origin'], '/echo-set' => ['l=1', 'cross-site'])
  end

  # RFC 6265bis §5.2: a reload through a user interface element (the driver's `refresh`) is same-site where the
  # document it reloads was reached by a same-site request — a page a cross-site link led to sends its Strict cookies
  # on no reload of the user's — where the page's own `location.reload()` is judged by its document's site, as any of
  # its navigations.
  it "judges a reload of the user's as the request its document was reached by" do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'  then [200, {'content-type' => 'text/html', 'set-cookie' => 's=1; SameSite=Strict; Path=/'}, ['set']]
      when '/link' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><a href="http://a.test/home">go</a>']]
      else
        seen << [req.path, env['HTTP_COOKIE'].to_s]
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>home']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'http://a.test/set'
    s.visit 'http://b.test/link'
    s.click_link 'go'
    s.refresh
    s.execute_script('location.reload()')
    s.evaluate_script('1')
    s.visit 'http://a.test/mine'
    s.refresh
    expect(seen).to eq([['/home', ''], ['/home', ''], ['/home', 's=1'], ['/mine', 's=1'], ['/mine', 's=1']])
  end

  # …an entry of the same document — a pushState's, a fragment navigation's — as that document was reached (HTML: the
  # two share its document state), and an error document's as the request that failed was.
  it "judges a user's reload of a pushed entry and of an error document as their document was reached" do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      case req.path
      when '/set'  then [200, {'content-type' => 'text/html', 'set-cookie' => 's=1; SameSite=Strict; Path=/'}, ['set']]
      when '/link' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><a href="http://a.test/home">go</a> <a href="http://a.test/fail">fail</a>']]
      else
        seen << [req.path, env['HTTP_COOKIE'].to_s]
        # (…a redirect to a `data:` URL a network error, its error document at the URL)
        next [302, {'location' => 'data:text/html,x'}, ['']] if req.path == '/fail'

        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>home']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'http://a.test/set'
    s.visit 'http://b.test/link'
    s.click_link 'go'
    s.execute_script("history.pushState({}, '', '/pushed')")
    s.refresh
    s.execute_script("location.hash = 'x'")
    s.refresh
    s.visit 'http://b.test/link'
    s.click_link 'fail'
    s.refresh
    expect(seen).to eq([['/home', ''], ['/pushed', ''], ['/pushed', ''], ['/fail', ''], ['/fail', '']])
  end

  # Fetch "HTTP-network fetch": a response's cookies are stored only where its request included credentials — so a
  # same-site, cross-origin fetch() of the default credentials mode (`same-origin`) leaves the jar as it was, where one
  # of `include` (that the response allows) stores them.
  it 'stores no cookie a fetch() that included no credentials was answered with' do
    seen = []
    app = lambda {|env|
      req = Rack::Request.new(env)
      seen << env['HTTP_COOKIE'].to_s if req.path == '/echo'
      case req.path
      when '/give'
        allow = {'access-control-allow-origin' => 'http://www.example.com', 'access-control-allow-credentials' => 'true'}
        [200, allow.merge('content-type' => 'text/plain', 'set-cookie' => "#{req.params['name']}=1; Path=/"), ['ok']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body>page']]
      end
    }
    s = every_host_local { simulated_session(app) }
    s.visit 'http://www.example.com/'
    s.evaluate_async_script(<<~JS)
      const done = arguments[arguments.length - 1];
      fetch('http://api.example.com/give?name=kept')
        .then(() => fetch('http://api.example.com/give?name=sent', {credentials: 'include'}))
        .then(() => done(), () => done());
    JS
    s.visit 'http://api.example.com/echo'
    expect(seen).to eq(['sent=1'])
  end

  # An image is fetched under its own `referrerpolicy` attribute where it has one, else its document's (HTML).
  it "refers an image's request under its referrerpolicy attribute" do
    seen = {}
    app = lambda {|env|
      req = Rack::Request.new(env)
      seen[req.params['id']] = env['HTTP_REFERER'] if req.path == '/i'
      next [200, {'content-type' => 'image/gif'}, ['GIF89a']] if req.path == '/i'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><img src="/i?id=plain"><img referrerpolicy="no-referrer" src="/i?id=none"><img referrerpolicy="bogus" src="/i?id=bogus">']]
    }
    s = simulated_session(app)
    s.visit 'http://www.example.com/page'
    expect(seen).to eq('plain' => 'http://www.example.com/page', 'none' => nil, 'bogus' => 'http://www.example.com/page')
  end

  # …nor may it run a worker from an http(s) script: no script is same-origin with an opaque origin, so its fetch is a
  # network error and the worker's `error` fires (HTML "fetch a classic worker script", mode same-origin).
  it 'fails a sandboxed document a worker' do
    s = simulated_session(app)
    s.visit 'http://www.example.com/sandboxed-worker'
    expect(poll_until { s.evaluate_script('window.got') }).to eq('error')
    expect(seen.map {|_, path, _| path }).not_to include('/w.js')
  end
end
