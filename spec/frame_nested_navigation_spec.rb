require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A frame's document navigating itself (its `location`) navigates the container's navigable — HTML "navigate" — which
# writes none of the container's attributes: its `src` stays what the page set, whatever the URL's scheme.
RSpec.describe 'a nested document navigating itself' do
  include PollUntil

  def session
    pages = {
      '/'  => '<!DOCTYPE html><meta charset="utf-8"><body><iframe id=f src="/o"></iframe>',
      '/o' => '<!DOCTYPE html><meta charset="utf-8"><p>o'
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
    s.visit '/'
    s
  end

  it "keeps the container's src for a blob: URL, the bytes taken before the page revoked it" do
    s = session
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument?.body?.textContent') == 'o' }
    s.execute_script(<<~JS)
      const f = document.getElementById('f');
      window.R = [];
      new MutationObserver((records) => R.push(...records.map((r) => r.attributeName))).observe(f, {attributes: true});
      const w = f.contentWindow;
      const url = w.URL.createObjectURL(new w.Blob(['<p>b'], {type: 'text/html'}));
      w.location = url;
      w.URL.revokeObjectURL(url);
    JS
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument.body?.textContent') == 'b' }
    expect(s.evaluate_script('[document.getElementById("f").getAttribute("src"), R]')).to eq(['/o', []])
  end

  # …and a reload reloads the document it navigated to, not that `src`.
  it 'reloads the URL it navigated to' do
    s = session
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument?.body?.textContent') == 'o' }
    s.execute_script('document.getElementById("f").contentWindow.location = "about:blank"')
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument.URL') == 'about:blank' }
    s.execute_script('document.getElementById("f").contentWindow.location.reload()')
    sleep 0.2
    expect(poll_until { s.evaluate_script('document.getElementById("f").contentDocument.URL') }).to eq('about:blank')
  end

  # A frame's later navigation replaces the one it planned before (HTML "navigate"): `href = …` then `reload()` in one
  # task reloads the document the frame is at, and `reload()` then `href = …` goes to the URL (Chrome, measured: A, then
  # B, for the same two orders).
  it 'lets a later navigation of a frame replace the one it planned before' do
    hits = []
    pages = {'/' => '<!DOCTYPE html><meta charset="utf-8"><iframe id=f src="/a"></iframe>'}
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO']) { "<!DOCTYPE html><meta charset=\"utf-8\"><p>#{env['PATH_INFO']}" }]]
    })
    s.visit '/'
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/a' }
    hits.clear
    s.execute_script("const w = f.contentWindow; w.location.href = '/b'; w.location.reload();")
    poll_until { hits.include?('/a') }
    expect([hits, s.evaluate_script('f.contentDocument.body.textContent')]).to eq([['/a'], '/a'])
    hits.clear
    s.execute_script("const w = f.contentWindow; w.location.reload(); w.location.href = '/c';")
    poll_until { s.evaluate_script('f.contentDocument.body.textContent') == '/c' }
    expect(hits).to eq(['/c'])
  end

  # …and a frame's form submitted twice in one task submits what the later submission planned.
  it 'submits the later of two submissions a frame makes in one task' do
    hits = []
    pages = {
      '/'  => '<!DOCTYPE html><meta charset="utf-8"><iframe id=f src="/a"></iframe>',
      '/a' => '<!DOCTYPE html><meta charset="utf-8"><form id=fm action="/fs"><input name=q value=1></form>'
    }
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO'] + (env['QUERY_STRING'].empty? ? '' : "?#{env['QUERY_STRING']}")
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '<!DOCTYPE html><meta charset="utf-8"><p>done')]]
    })
    s.visit '/'
    poll_until { s.evaluate_script('f.contentDocument?.getElementById("fm") != null') }
    hits.clear
    s.execute_script("const d = f.contentDocument; d.getElementById('fm').submit(); d.querySelector('[name=q]').value = '2'; d.getElementById('fm').submit();")
    poll_until { hits.any? }
    expect(hits).to eq(['/fs?q=2'])
  end

  # A frame navigated away from has its whole tree unloaded before any of it is destroyed: an unload handler of one frame
  # still reaches its sibling's document, unloaded but not gone (Chrome, measured: the sibling `closed` false, its body
  # readable). (A removed frame's tree fires no unload at all: HTML "destroy a child navigable".)
  it "unloads a navigated frame's whole tree before destroying any of it" do
    leaf = '<!DOCTYPE html><meta charset=utf-8><body>leaf'
    g2 = '<!DOCTYPE html><meta charset=utf-8><script>onunload = () => { const s = parent.frames[0]; ' \
         'top.seen = [s.closed, s.document.body.textContent]; }</script>'
    c = %(<!DOCTYPE html><meta charset=utf-8><iframe srcdoc="#{leaf}"></iframe><iframe srcdoc="#{g2.gsub('"', '&quot;')}"></iframe>)
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<!DOCTYPE html><meta charset="utf-8"><iframe id=c srcdoc="#{c.gsub('&', '&amp;').gsub('"', '&quot;')}"></iframe>)]] })
    s.visit '/'
    poll_until { s.evaluate_script('c.contentWindow?.frames?.[1]?.document?.readyState') == 'complete' }
    s.execute_script("c.srcdoc = '<p>gone'")
    expect(poll_until { s.evaluate_script('top.seen') }).to eq([false, 'leaf'])
  end

  # A frame's `src` set records the session history entry of the URL it navigates to — parsed against its document's base
  # URL — so a traversal back and forward returns to that document.
  it "records a frame's navigation by its src parsed against the base URL" do
    hits = []
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><base href="/sub/"><iframe id=f src="/a"></iframe>']] if env['PATH_INFO'] == '/'

      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><p>#{env['PATH_INFO']}"]]
    })
    s.visit '/'
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/a' }
    s.execute_script("f.src = 'b'")
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/sub/b' }
    s.execute_script('f.contentWindow.history.back()')
    poll_until { s.evaluate_script('f.contentDocument?.body?.textContent') == '/a' }
    hits.clear
    s.execute_script('f.contentWindow.history.forward()')
    poll_until { hits.any? }
    expect(hits).to eq(['/sub/b'])
  end

  # A frame a handler of a document above it removes as that one unloads — a navigation away — is one of its descendants,
  # unloaded with it ("unload a document and its descendants"), not destroyed: its pagehide and unload fire.
  it "unloads a descendant an ancestor's unload handler removes" do
    g = '<!DOCTYPE html><meta charset=utf-8><script>for (const t of ["pagehide", "unload"]) addEventListener(t, () => top.L.push("g2:" + t))</script>'
    a = %(<!DOCTYPE html><meta charset=utf-8><iframe id=g1 srcdoc="x"></iframe><iframe id=g2 srcdoc="#{g.gsub('"', '&quot;')}"></iframe>) +
        '<script>addEventListener("unload", () => document.getElementById("g2").remove())</script>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [%(<!DOCTYPE html><meta charset="utf-8"><script>var L = []</script><iframe id=a srcdoc="#{a.gsub('&', '&amp;').gsub('"', '&quot;')}"></iframe>)]] })
    s.visit '/'
    poll_until { s.evaluate_script('a.contentWindow?.frames?.[1]?.document?.readyState') == 'complete' }
    s.execute_script("a.srcdoc = '<p>gone'")
    expect(poll_until { s.evaluate_script('L').then {|l| l if l.size >= 2 } }).to eq(%w[g2:pagehide g2:unload])
  end

  # A frame's `<a target=_top>` / `target=_parent` a script clicks navigates the navigable it chooses, the frame's
  # document its initiator — the page, a parent frame — and none its sandbox keeps it from (Chrome).
  it "follows a frame's _top and _parent links its script clicks" do
    log = []
    page = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
    s = simulated_session(lambda {|env|
      log << [env['PATH_INFO'], env['HTTP_REFERER']]
      case env['PATH_INFO']
      when '/' then page.('<iframe src="/n"></iframe><iframe sandbox="allow-scripts allow-same-origin" src="/a"></iframe><iframe src="/a"></iframe>')
      when '/a' then page.('<a id="tl" href="/t" target="_top">tl</a>')
      when '/n' then page.('N<iframe src="/b"></iframe>')
      when '/b' then page.('<a id="pl" href="/p" target="_parent">pl</a>')
      else page.(env['PATH_INFO'])
      end
    })
    s.visit '/'
    s.within_frame(0) { s.within_frame(0) { s.execute_script("document.getElementById('pl').click()") } }
    poll_until { s.evaluate_script('frames[0].document.body.textContent') == '/p' }
    s.within_frame(1) { s.execute_script("document.getElementById('tl').click()") }
    s.evaluate_script('1')
    expect(s).to have_current_path('/')
    s.within_frame(2) { s.execute_script("document.getElementById('tl').click()") }
    expect(s).to have_current_path('/t')
    expect(log.last).to eq(['/t', 'http://www.example.com/a'])
  end

  # …under the policy the link's `rel` sets (Chrome: no Referer for `noreferrer`); a fragment of the frame's own URL a
  # new document of the page — judged against the page's URL, not the frame's (Chrome loads "/f#zz"); and none to a
  # `data:` URL, which a top-level navigation refuses (Chrome).
  it "follows a frame's _top link under its rel, against the page's URL, and to no data: URL" do
    log = []
    page = ->(body) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]] }
    s = simulated_session(lambda {|env|
      log << [env['PATH_INFO'], env['HTTP_REFERER']]
      case env['PATH_INFO']
      when '/' then page.('TOP<iframe src="/f"></iframe>')
      when '/f' then page.('F<a id="n" href="/t" rel="noreferrer" target="_top">n</a><a id="z" href="#zz" target="_top">z</a><a id="d" href="data:text/html,x" target="_top">d</a>')
      else page.(env['PATH_INFO'])
      end
    })
    s.visit '/'
    s.within_frame(0) { s.execute_script("document.getElementById('d').click()") }
    s.evaluate_script('1')
    expect(s).to have_current_path('/')
    s.within_frame(0) { s.execute_script("document.getElementById('z').click()") }
    expect(s).to have_current_path('/f')
    expect(s.evaluate_script('location.hash')).to eq('#zz')
    expect(log.last).to eq(['/f', 'http://www.example.com/f'])
    s.visit '/'
    s.within_frame(0) { s.execute_script("document.getElementById('n').click()") }
    expect(s).to have_current_path('/t')
    expect(log.last).to eq(['/t', nil])
  end

  # A script of an entered frame setting the page's location navigates the page, as the frame's own script does (HTML:
  # a Location navigates its own window's navigable, whichever realm's script calls it).
  {
    "top.location.href = '/x'"   => '/x',
    "top.location.assign('/x')"  => '/x',
    "top.location.replace('/x')" => '/x',
    "parent.location = '/x#h'"   => '/x'
  }.each do |js, path|
    it "navigates the page for `#{js}` run in an entered frame" do
      s = simulated_session(lambda {|env|
        body = env['PATH_INFO'] == '/' ? 'TOP<iframe src="/f"></iframe>' : env['PATH_INFO']
        [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
      })
      s.visit '/'
      s.within_frame(0) { s.execute_script(js) }
      expect(s).to have_current_path(path)
      expect(s.evaluate_script('document.body.textContent')).to eq(path)
    end
  end

  # A frame's navigation redirected as no fetch follows ends as a top-level one does: a fetch scheme's that is no HTTP(S)
  # one, or one past the redirect limit, a network error committed at the URL that redirected (Chrome: an error page
  # there); one of no fetch scheme handed off, the frame's document left as it is.
  {
    'about:blank'      => ['/r?to=about:blank', '/r'],
    'data:'            => ['/r?to=data:text/html,x', '/r'],
    'twenty redirects' => ['/loop0', '/loop20'],
    '//[bad'           => ['/r?to=//[bad', '/r'],
    'mailto:'          => ['/r?to=mailto:a@b.c', '/o']
  }.each do |name, (start, landed)|
    it "ends a frame's navigation redirected to #{name}" do
      s = simulated_session(lambda {|env|
        case env['PATH_INFO']
        when '/r' then [302, {'location' => env['QUERY_STRING'].delete_prefix('to=')}, []]
        when %r{\A/loop(\d+)} then [302, {'location' => "/loop#{::Regexp.last_match(1).to_i + 1}"}, []]
        when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe src="/o"></iframe>']]
        else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><p>o']]
        end
      })
      s.visit '/'
      poll_until { s.evaluate_script('frames[0].document.body?.textContent') == 'o' }
      s.execute_script("frames[0].location.href = '#{start}'")
      poll_until { s.evaluate_script('frames[0].location.pathname') == landed }
      expect(s.evaluate_script('[frames[0].location.pathname, frames[0].document.body?.textContent || ""]')).to eq([landed, landed == '/o' ? 'o' : ''])
    end
  end

  # A frame entered with `within_frame` and navigated there loads its new document's subresources — its scripts, its
  # style sheets — as any document does: they ask as it is built, before the frame is pointed at it.
  it "loads the subresources of an entered frame's new document" do
    s = simulated_session(lambda {|env|
      case env['PATH_INFO']
      when '/s.js' then [200, {'content-type' => 'text/javascript'}, ['window.ran = 1']]
      when '/c.css' then [200, {'content-type' => 'text/css'}, ['p { color: rgb(255, 0, 0) }']]
      when '/g' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><link rel="stylesheet" href="c.css"><script src="s.js"></script><p id="p">x</p>']]
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe src="/f"></iframe>']]
      else [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><a href="/g">g</a>']]
      end
    })
    s.visit '/'
    s.within_frame(0) do
      s.click_link 'g'
      expect(s.evaluate_script('[window.ran, getComputedStyle(document.getElementById("p")).color]')).to eq([1, 'rgb(255, 0, 0)'])
    end
  end

  # …and one whose document a handler removed, before what it began navigates, navigates nothing: a form submitted or a
  # link followed (HTML "cannot navigate"; Chrome: no request).
  it 'navigates nothing for an entered frame removed before its navigation' do
    seen = []
    s = simulated_session(lambda {|env|
      seen << env['PATH_INFO'] unless %w[/ /f].include?(env['PATH_INFO'])
      next [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe src="/f"></iframe>']] if env['PATH_INFO'] == '/'

      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!DOCTYPE html><meta charset="utf-8">
        <form action="/act" method="post"><button onclick="var f = frameElement; setTimeout(() => f.remove())">p</button></form>
        <a href="/lnk" onclick="frameElement.remove()">l</a>
      HTML
    })
    s.visit '/'
    s.within_frame(0) { s.click_button 'p' } rescue Capybara::Simulated::StaleElement
    s.visit '/'
    s.within_frame(0) { s.click_link 'l' } rescue Capybara::Simulated::StaleElement
    s.evaluate_script('1')
    expect(seen).to eq([])
  end

  # An entered frame's navigations are entries of its session history, as its own are: `history.back()` returns to the
  # document it left, a reload of a POST's document re-posts it, and a redirect's entry is the page it was sent to.
  it "keeps an entered frame's navigations in its session history" do
    seen = []
    s = simulated_session(lambda {|env|
      seen << [env['REQUEST_METHOD'], env['PATH_INFO']] unless env['PATH_INFO'] == '/'
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe src="/f"></iframe>']]
      when '/x' then [303, {'location' => '/r'}, []]
      when '/f' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><a href="/g">g</a><form action="/p" method="post"><button>p</button></form><form action="/x" method="post"><button>x</button></form>']]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><p>#{env['PATH_INFO']}"]]
      end
    })
    s.visit '/'
    s.within_frame(0) do
      s.click_link 'g'
      s.execute_script('history.back()')
      expect(s).to have_link('g')
      s.click_button 'p'
      s.execute_script('location.reload()')
      expect(s).to have_text('/p')
      s.execute_script('history.back()')
      expect(s).to have_button('x')
      s.click_button 'x'
      s.execute_script('location.reload()')
      expect(s).to have_text('/r')
    end
    expect(seen).to eq([%w[GET /f], %w[GET /g], %w[GET /f], %w[POST /p], %w[POST /p], %w[GET /f], %w[POST /x], %w[GET /r], %w[GET /r]])
  end

  # …and a frame removed and inserted again is a new navigable, with a session history of its own: its first navigation
  # replaces its new initial about:blank, none of the old navigable's entries to go back to (HTML "destroy a child
  # navigable").
  it 'forgets a removed frame\'s session history' do
    s = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/' ? '<iframe></iframe>' : "<p>#{env['PATH_INFO']}"
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\">#{body}"]]
    })
    s.visit '/'
    s.execute_script("frames[0].location = '/g'")
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/g' }
    s.execute_script("const f = document.querySelector('iframe'); f.remove(); document.body.append(f)")
    s.execute_script("frames[0].location = '/h'")
    poll_until { s.evaluate_script('frames[0].location.pathname') == '/h' }
    s.execute_script('frames[0].history.back()')
    s.evaluate_script('1')
    expect(s.evaluate_script('frames[0].location.pathname')).to eq('/h')
  end

  # A page's form submitted to a named frame is an entry of the frame's session history too: a POST's re-posted by a
  # reload or a traversal to it, a Post/Redirect/Get's the page it was sent to.
  it "keeps a page form's navigation of a named frame in the frame's session history" do
    seen = []
    s = simulated_session(lambda {|env|
      seen << [env['REQUEST_METHOD'], env['PATH_INFO']] unless env['PATH_INFO'] == '/'
      case env['PATH_INFO']
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><iframe name="fr" src="/f"></iframe><form id="p" action="/p" method="post" target="fr"></form><form id="x" action="/x" method="post" target="fr"></form>']]
      when '/x' then [303, {'location' => '/r'}, []]
      else [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><p>#{env['PATH_INFO']}"]]
      end
    })
    step = lambda {|js|
      s.execute_script(js)
      s.evaluate_script('1')
    }
    s.visit '/'
    poll_until { s.evaluate_script('frames[0].document.body?.textContent') == '/f' }
    step.('p.submit()')
    poll_until { s.evaluate_script('frames[0].document.body?.textContent') == '/p' }
    step.('frames[0].location.reload()')
    step.('frames[0].history.back()')
    poll_until { s.evaluate_script('frames[0].document.body?.textContent') == '/f' }
    step.('x.submit()')
    poll_until { s.evaluate_script('frames[0].document.body?.textContent') == '/r' }
    step.('frames[0].location.reload()')
    expect(seen).to eq([%w[GET /f], %w[POST /p], %w[POST /p], %w[GET /f], %w[POST /x], %w[GET /r], %w[GET /r]])
  end

  # A nested frame's `location.reload()` reloads its document, its container the one its parent frame's document holds.
  it "reloads a nested frame's document" do
    hits = []
    s = simulated_session(lambda {|env|
      hits << env['PATH_INFO']
      body = case env['PATH_INFO']
             when '/' then '<iframe src="/fa"></iframe>'
             when '/fa' then 'FA<iframe src="/c0"></iframe>'
             else env['PATH_INFO']
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body>#{body}"]]
    })
    s.visit '/'
    expect(s.evaluate_script('frames[0].frames[0].location.pathname')).to eq('/c0')
    hits.clear
    s.execute_script('frames[0].frames[0].location.reload()')
    s.evaluate_script('1')
    expect(hits).to eq(['/c0'])
  end
end
