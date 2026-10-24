# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# HTML "submit" builds a form's request — its action, method, entries — before it plans the navigation: what the page
# does to the form after `submit()` returns is no part of what it sends. And a form whose node document is no longer
# fully active cannot navigate at all.
RSpec.describe "a form submission's request" do
  include PollUntil

  html = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]] }

  # Chrome: "/r.html?q=orig".
  it 'is what the form was as it was submitted' do
    app = lambda {|env|
      next html.("<body>#{env['PATH_INFO']}?#{env['QUERY_STRING']}") unless env['PATH_INFO'] == '/'

      html.('<body><form id="f" action="/r"><input name="q" value="orig"></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.execute_script("f.submit(); f.q.value = 'changed'; f.action = '/other';")
    expect(session).to have_current_path('/r?q=orig')
  end

  # WPT reparent-form-during-planned-navigation-task: a form moved into another document after `submit()` still
  # navigates the frame it was submitted in.
  it 'navigates even where the form is moved to another document after it' do
    app = lambda {|env|
      next html.('<body>blank') if env['PATH_INFO'] == '/b'

      html.(<<~HTML)
        <body><script>var log = [];</script><iframe id="i" src="about:blank"></iframe>
        <script>
          const form = i.contentDocument.createElement('form');
          form.action = '/b';
          i.contentDocument.body.appendChild(form);
          i.onload = () => log.push(i.contentDocument.body.textContent);
          form.submit();
          new Document().prepend(form);
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 1 }
    expect(session.evaluate_script('log')).to eq(['blank'])
  end

  # WPT submission-checks "<form> in a navigated document cannot navigate": a form of a document its frame navigated
  # away from submits nothing — the page stays where it is.
  it 'is none for a form whose document is no longer fully active' do
    app = lambda {|env|
      next html.('<body>frame') if env['PATH_INFO'] == '/f'
      next html.('<body>submitted') if env['PATH_INFO'] == '/s'

      html.(<<~HTML)
        <body><script>var log = [];</script><iframe id="i"></iframe>
        <script>
          const form = i.contentDocument.createElement('form');
          form.action = '/s';
          i.contentDocument.body.appendChild(form);
          i.onload = () => { if (i.contentWindow.location.pathname === '/f') { form.submit(); log.push('submitted'); } };
          i.src = '/f';
        </script>
      HTML
    }
    session = simulated_session(app)
    session.visit '/'
    poll_until { session.evaluate_script('log.length') >= 1 }
    session.evaluate_script('1')
    expect(session).to have_current_path('/')
    expect(session.evaluate_script('i.contentDocument.body.textContent')).to eq('frame')
  end

  # …and is its node document's to plan, whichever realm's code submits it: a form the page made and moved into a frame's
  # document navigates the frame, not the page (Chrome).
  it "navigates the navigable of the form's document" do
    app = lambda {|env|
      next html.("<body>#{env['PATH_INFO']}?#{env['QUERY_STRING']}") unless env['PATH_INFO'] == '/'

      html.('<body><iframe id="i"></iframe>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.execute_script(<<~JS)
      const g = document.createElement('form');
      g.action = '/moved';
      g.innerHTML = '<input name="q" value="pv">';
      i.contentDocument.body.appendChild(g);
      g.submit();
    JS
    poll_until { session.evaluate_script('i.contentDocument.body.textContent') == '/moved?q=pv' }
    expect(session).to have_current_path('/')
  end

  # A frame's form targeting `_top` navigates the page, and one targeting `_parent` its parent — the page where that
  # is the frame's parent (Chrome); none where the frame's sandbox keeps it from navigating the page.
  {
    'top'                => ['<iframe srcdoc="<form id=f action=/t target=_top><input name=q value=1></form>"></iframe>', '/t?q=1'],
    'parent'             => ['<iframe srcdoc="<form id=f action=/p target=_parent><input name=q value=2></form>"></iframe>', '/p?q=2'],
    'sandboxed (no top)' => ['<iframe sandbox="allow-scripts allow-forms allow-same-origin" srcdoc="<form id=f action=/s target=_top><input name=q value=3></form>"></iframe>', '/']
  }.each do |name, (frame, path)|
    it "navigates the navigable a frame's form's #{name} target chooses" do
      app = lambda {|env|
        next html.("<body>#{env['PATH_INFO']}") unless env['PATH_INFO'] == '/'

        html.("<body>#{frame}")
      }
      session = simulated_session(app)
      session.visit '/'
      session.within_frame(0) { session.execute_script('f.submit()') }
      expect(session).to have_current_path(path)
    end
  end

  # A frame's own navigation replaces a submission of it that navigates the frame, not one that navigates the page
  # (Chrome: "/t?q=1"); a frame's submission to the page is the page's navigation planned last, replacing the location,
  # reload or form submission the page planned before it — the frame gone or not by then — and replaced by the one the
  # page plans after it (Chrome, each).
  {
    "f.submit(); location.href = '/x'"                            => '/t?q=1',
    "top.location.href = '/y'; f.submit()"                        => '/t?q=1',
    "top.location.href = '/y'; f.submit(); frameElement.remove()" => '/t?q=1',
    'top.location.reload(); f.submit()'                           => '/t?q=1',
    "f.submit(); top.document.getElementById('g').submit()"       => '/m?q=m',
    "top.location.href = '/y'; f.submit(); h.submit()"            => '/t?q=1'
  }.each do |js, path|
    it "navigates the page a frame's form targets after `#{js}`" do
      app = lambda {|env|
        next html.("<body>#{env['PATH_INFO']}") unless env['PATH_INFO'] == '/'

        html.('<body><form id="g" action="/m"><input name="q" value="m"></form><iframe srcdoc="<form id=f action=/t target=_top><input name=q value=1></form><form id=h action=/hs></form>"></iframe>')
      }
      session = simulated_session(app)
      session.visit '/'
      session.within_frame(0) { session.execute_script(js) }
      expect(session).to have_current_path(path)
    end
  end

  # A POST navigation carries its initiating document's origin (Fetch "append a request Origin header"; Chrome and
  # Firefox send it): the page's, and 'null' for an opaque-origin frame's submission to the page.
  # Its referrer policy withholds it as 'null' where it would withhold the origin (Fetch "append a request Origin
  # header": a `no-referrer` page's, measured in Chrome and Firefox; a `noreferrer` form's too, as HTML and Fetch have
  # it, where Chrome and Firefox send the origin), and a document of an opaque origin sends 'null' — a sandboxed frame's
  # to the page or a new window, a `Content-Security-Policy: sandbox` page's.
  {
    'the page'                         => ['<form action="/r" method="post"><button>go</button></form>', false, 'http://www.example.com'],
    'a no-referrer page'               => ['<meta name="referrer" content="no-referrer"><form action="/r" method="post"><button>go</button></form>', false, 'null'],
    'an origin-when-cross-origin page' => ['<meta name="referrer" content="origin-when-cross-origin"><form action="http://other.example.com/r" method="post"><button>go</button></form>', false, 'http://www.example.com'],
    'a noreferrer form'                => ['<form action="/r" method="post" rel="noreferrer"><button>go</button></form>', false, 'null'],
    'a sandboxed page'                 => ['<form action="/r" method="post"><button>go</button></form>', true, 'null'],
    'an opaque frame, to _top'         => ['<iframe sandbox="allow-forms allow-top-navigation" srcdoc="<form action=/r method=post target=_top><button>go</button></form>"></iframe>', false, 'null'],
    'an opaque frame, to _blank'       => ['<iframe sandbox="allow-forms allow-popups" srcdoc="<form action=/r method=post target=_blank><button>go</button></form>"></iframe>', false, 'null']
  }.each do |name, (body, sandboxed, origin)|
    it "sends the Origin of #{name} on a POST navigation" do
      origins = []
      app = lambda {|env|
        origins << env['HTTP_ORIGIN'] if env['PATH_INFO'] == '/r'
        next html.('<body>r') if env['PATH_INFO'] == '/r'

        status, headers, page = html.("<body>#{body}")
        headers = headers.merge('content-security-policy' => 'sandbox allow-forms allow-scripts') if sandboxed
        [status, headers, page]
      }
      session = simulated_session(app)
      session.visit '/'
      if body.include?('iframe')
        session.within_frame(0) { session.click_button('go') }
      else
        session.click_button('go')
      end
      poll_until { origins.any? }
      expect(origins).to eq([origin])
    end
  end

  # …and a reload or a traversal re-posting it sends the origin it was first sent with (HTML: the document state's
  # initiator origin).
  it 'sends the Origin it was first sent with on a re-post from its session history entry' do
    origins = []
    app = lambda {|env|
      origins << env['HTTP_ORIGIN'] if env['PATH_INFO'] == '/r'
      next html.('<body>r') if env['PATH_INFO'] == '/r'
      next html.('<body>other') if env['PATH_INFO'] == '/other'

      html.('<body><form action="/r" method="post"><button>go</button></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.click_button('go')
    session.refresh
    session.visit '/other'
    session.go_back
    expect(session).to have_current_path('/r')
    expect(origins).to eq(['http://www.example.com'] * 3)
  end

  # …under the referrer policy it was first sent under, not the page it reached's: a `no-referrer` form page's POST is
  # re-posted with `Origin: null` and no Referer (Chrome).
  it 're-posts under the referrer policy it was first sent under' do
    seen = []
    app = lambda {|env|
      seen << [env['HTTP_ORIGIN'], env['HTTP_REFERER']] if env['PATH_INFO'] == '/r'
      next html.('<body>r') if env['PATH_INFO'] == '/r'

      html.('<meta name="referrer" content="no-referrer"><body><form action="/r" method="post"><button>go</button></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.click_button('go')
    session.refresh
    expect(seen).to eq([['null', nil]] * 2)
  end

  # A POST redirected to a GET leaves its session history entry the GET's: a reload of a Post/Redirect/Get page gets
  # the page it was sent to, and submits nothing again (Chrome: `GET /r`).
  it 'reloads the page a POST was redirected to, not the POST' do
    seen = []
    app = lambda {|env|
      seen << [env['REQUEST_METHOD'], env['PATH_INFO']] unless env['PATH_INFO'] == '/'
      next [303, {'location' => '/r'}, []] if env['PATH_INFO'] == '/x'
      next html.('<body>r') if env['PATH_INFO'] == '/r'

      html.('<body><form action="/x" method="post"><button>go</button></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.click_button('go')
    session.refresh
    expect(session).to have_current_path('/r')
    expect(seen).to eq([%w[POST /x], %w[GET /r], %w[GET /r]])
  end

  # …as a GET's redirect does: a reload of a redirected page gets it, not the redirect (Chrome).
  it 'reloads the page a GET was redirected to' do
    seen = []
    app = lambda {|env|
      seen << env['PATH_INFO']
      next [302, {'location' => '/b'}, []] if env['PATH_INFO'] == '/a'

      html.('<body>b')
    }
    session = simulated_session(app)
    session.visit '/a'
    session.refresh
    expect(session).to have_current_path('/b')
    expect(seen).to eq(%w[/a /b /b])
  end

  # A redirect to a URL of a fetch scheme that is no HTTP(S) one is a network error, committed at the URL that
  # redirected — which a reload requests again (HTML "create navigation params by fetching"; Chrome:
  # ERR_UNSAFE_REDIRECT)…
  ['about:blank', 'data:text/html,x', 'blob:http://www.example.com/x', 'http://[bad', '//[bad'].each do |target|
    it "fails a navigation redirected to #{target}" do
      seen = []
      app = lambda {|env|
        seen << env['PATH_INFO']
        next [302, {'location' => target}, []] if env['PATH_INFO'] == '/a'

        html.('<body>b')
      }
      session = simulated_session(app)
      session.visit '/a'
      expect(session.current_url).to eq('http://www.example.com/a')
      expect(session.evaluate_script('document.body?.textContent || ""')).to eq('')
      session.refresh
      expect(seen).to eq(%w[/a /a])
    end
  end

  # …and one to a URL of no fetch scheme is handed off: nothing committed, the page and its history as they were (Chrome:
  # ERR_ABORTED).
  %w[mailto:a@b.c myapp://cb?code=1].each do |target|
    it "leaves the page as it was for a navigation redirected to #{target.split(':').first}:" do
      app = lambda {|env|
        next [302, {'location' => target}, []] if env['PATH_INFO'] == '/a'

        html.('<body>start')
      }
      session = simulated_session(app)
      session.visit '/start'
      session.visit '/a'
      expect(session.current_url).to eq('http://www.example.com/start')
      expect(session.evaluate_script('[document.body.textContent, history.length]')).to eq(['start', 1])
    end
  end

  # …and one past the redirect limit fails as well: twenty redirects followed, the twenty-first not, the last URL
  # requested the error document's (Fetch "HTTP-redirect fetch"'s redirect count; Firefox — Chrome follows nineteen).
  it 'fails a navigation past its redirect limit' do
    seen = []
    app = lambda {|env|
      seen << env['PATH_INFO']
      [302, {'location' => "/loop#{env['PATH_INFO'][/\d+/].to_i + 1}"}, []]
    }
    session = simulated_session(app)
    session.visit '/loop0'
    expect(seen).to eq((0..20).map {|i| "/loop#{i}" })
    expect(session.current_url).to eq('http://www.example.com/loop20')
  end

  # …and a re-post that ends in a download leaves the entry the POST's: the next reload re-posts it (Chrome).
  it 'keeps the entry of a re-post that ends in a download' do
    seen = []
    app = lambda {|env|
      seen << [env['REQUEST_METHOD'], env['PATH_INFO']] unless env['PATH_INFO'] == '/'
      next [200, {'content-type' => 'text/plain', 'content-disposition' => 'attachment; filename=f.txt'}, ['f']] if env['PATH_INFO'] == '/dl'
      next [302, {'location' => '/dl'}, []] if env['PATH_INFO'] == '/r' && seen.count(%w[POST /r]) > 1
      next html.('<body>r') if env['PATH_INFO'] == '/r'

      html.('<body><form action="/r" method="post"><button>go</button></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.click_button('go')
    session.refresh
    session.refresh
    expect(session).to have_current_path('/r')
    expect(seen).to eq([%w[POST /r], %w[POST /r], %w[GET /dl], %w[POST /r], %w[GET /dl]])
  end

  # …and a submission to a named frame is that frame's navigation request: Sec-Fetch-Dest 'iframe', and a POST its
  # Origin (Fetch "create a navigation request"; Fetch Metadata).
  it 'sends the Fetch metadata and Origin of a navigation for a form submitted to a named frame' do
    seen = []
    app = lambda {|env|
      seen << [env['REQUEST_METHOD'], env['HTTP_SEC_FETCH_DEST'], env['HTTP_SEC_FETCH_MODE'], env['HTTP_ORIGIN']] if env['PATH_INFO'] == '/r'
      next html.('<body>r') if env['PATH_INFO'] == '/r'

      html.('<body><iframe name="f1"></iframe><iframe name="f2"></iframe><form id="g" action="/r" target="f1"></form><form id="p" action="/r" method="post" target="f2"></form>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.execute_script('g.submit(); p.submit()')
    poll_until { session.evaluate_script('1') && seen.size == 2 }
    expect(seen.sort).to eq([%w[GET iframe navigate] + [nil], %w[POST iframe navigate http://www.example.com]])
  end

  # A form whose link types include `noreferrer` sends no Referer, whatever it navigates (HTML "plan to navigate": the
  # referrer policy "no-referrer"); Chrome sends one from the page's own form, a departure from the spec it states.
  {
    'the page'          => ['', ''],
    'the page by POST'  => ['', ' method=post'],
    'its frame'         => [' target=fr', ''],
    'its frame by POST' => [' target=fr', ' method=post']
  }.each do |name, (target, method)|
    it "sends no Referer from a `noreferrer` form submitted to #{name}" do
      referers = []
      app = lambda {|env|
        referers << env['HTTP_REFERER'] if env['PATH_INFO'] == '/r'
        next html.('<body>r') if env['PATH_INFO'] == '/r'

        html.(%(<body><iframe name="fr"></iframe><form action="/r" rel="noreferrer"#{target}#{method}><button>go</button></form>))
      }
      session = simulated_session(app)
      session.visit '/'
      session.click_button 'go'
      poll_until { referers.any? }
      expect(referers).to eq([nil])
    end
  end

  # …and a frame's own `noreferrer` form submitted to the frame by its script sends none either (Firefox: none).
  # …and an entered frame's own navigations — a link, a form, a Location set, each hop of a redirect — the navigation
  # request's Fetch metadata (dest `iframe`) of the frame's document, cross-site and `Origin: null` for a sandboxed one.
  it "sends the Fetch metadata of an entered frame's own navigation" do
    seen = {}
    s = simulated_session(lambda {|env|
      seen[env['PATH_INFO']] = [env['HTTP_SEC_FETCH_SITE'], env['HTTP_SEC_FETCH_DEST'], env['HTTP_SEC_FETCH_MODE'], env['HTTP_ORIGIN']]
      next [302, {'location' => 'http://other.test/landed'}, ['']] if env['PATH_INFO'] == '/r'

      case env['PATH_INFO']
      when '/' then html.('<iframe src="/f"></iframe><iframe sandbox="allow-scripts allow-forms" src="/f"></iframe>')
      when '/f' then html.('<a href="/clicked">c</a><form method=post action="/posted"><button>go</button></form>')
      else html.(env['PATH_INFO'])
      end
    })
    s.visit '/'
    s.within_frame(0) { s.click_link 'c' }
    s.within_frame(1) { s.click_button 'go' }
    s.within_frame(0) { s.execute_script('location.href = "/r"') }
    s.evaluate_script('1')
    expect(seen.slice('/clicked', '/posted', '/r', '/landed')).to eq(
      '/clicked' => ['same-origin', 'iframe', 'navigate', nil],
      '/posted'  => ['cross-site', 'iframe', 'navigate', 'null'],
      '/r'       => ['same-origin', 'iframe', 'navigate', nil],
      '/landed'  => ['cross-site', 'iframe', 'navigate', nil]
    )
  end

  it "sends no Referer from a frame's own `noreferrer` form its script submits" do
    referers = []
    app = lambda {|env|
      referers << env['HTTP_REFERER'] if env['PATH_INFO'] == '/r'
      next html.('<body>r') if env['PATH_INFO'] == '/r'
      next html.('<body><form id="ff" action="/r" rel="noreferrer"></form>') if env['PATH_INFO'] == '/f'

      html.('<body><iframe src="/f"></iframe>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.execute_script('frames[0].ff.submit()')
    poll_until { referers.any? }
    expect(referers).to eq([nil])
  end

  # …and a frame entered with `within_frame` submits by a click as by its script: its sandbox keeps it from the page, and
  # its Referer is the frame's document.
  it "submits an entered frame's form to the page under the frame's sandbox and Referer" do
    referers = []
    app = lambda {|env|
      referers << [env['PATH_INFO'], env['HTTP_REFERER']] if env['PATH_INFO'] == '/t'
      next html.('<body><form action="/t" target="_top"><button>go</button></form>') if env['PATH_INFO'] == '/a'
      next html.('<body>t') if env['PATH_INFO'] == '/t'

      html.('<body><iframe src="/a"></iframe><iframe sandbox="allow-forms allow-scripts allow-same-origin" src="/a"></iframe>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.within_frame(1) { session.click_button('go') }
    expect(session).to have_current_path('/')
    session.within_frame(0) { session.click_button('go') }
    expect(session).to have_current_path('/t?')
    expect(referers).to eq([['/t', 'http://www.example.com/a']])
  end

  # …and a new window it opens refers to the frame's document too, under the frame's policy — not the page's.
  {
    'none'   => ['<meta name="referrer" content="no-referrer">', '', 'http://www.example.com/a'],
    'origin' => ['', '<meta name="referrer" content="origin">', 'http://www.example.com/']
  }.each do |name, (page_meta, frame_meta, referer)|
    it "opens a new window for an entered frame's `_blank` form under the frame's Referer and policy (#{name})" do
      referers = []
      app = lambda {|env|
        referers << env['HTTP_REFERER'] if env['PATH_INFO'] == '/t'
        next html.(%(#{frame_meta}<body><form action="/t" target="_blank"><button>go</button></form>)) if env['PATH_INFO'] == '/a'
        next html.('<body>t') if env['PATH_INFO'] == '/t'

        html.(%(#{page_meta}<body><iframe src="/a"></iframe>))
      }
      session = simulated_session(app)
      session.visit '/'
      session.within_frame(0) { session.click_button('go') }
      poll_until { referers.any? }
      expect(referers).to eq([referer])
    end
  end

  # …as by a target naming the page: the page navigated, its Referer the frame's document.
  it "submits an entered frame's form to the page its target names under the frame's Referer" do
    referers = []
    app = lambda {|env|
      referers << env['HTTP_REFERER'] if env['PATH_INFO'] == '/t'
      next html.('<body><form action="/t" target="topw" method="post"><button>go</button></form>') if env['PATH_INFO'] == '/a'
      next html.('<body>t') if env['PATH_INFO'] == '/t'

      html.('<body><script>window.name = "topw"</script><iframe src="/a"></iframe>')
    }
    session = simulated_session(app)
    session.visit '/'
    session.within_frame(0) { session.click_button('go') }
    expect(session).to have_current_path('/t')
    expect(referers).to eq(['http://www.example.com/a'])
  end
end
