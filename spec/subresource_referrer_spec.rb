# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A document's subresources are requested by that document (Fetch "client"): their Referer its URL under its referrer
# policy — or the one the element's `referrerpolicy` sets — a frame's style sheets, scripts, modules and fonts the
# frame's, not the page's.
RSpec.describe 'a subresource request' do
  let(:referers) { {} }
  let(:session) do
    refs = referers
    simulated_session(lambda {|env|
      path = env['PATH_INFO']
      refs[path] = env['HTTP_REFERER']
      next [200, {'content-type' => 'text/css'}, ['p{}']] if path.end_with?('.css')
      next [200, {'content-type' => 'text/javascript'}, ['1']] if path.end_with?('.js')

      body = case path
             when '/top' then '<link rel=stylesheet href=/top.css><iframe src="/f"></iframe>'
             when '/f' then '<link rel=stylesheet href=/f.css><script src=/f.js></script><script type=module src=/fm.js></script>' \
                            '<script>import("/fi.js")</script><style>@font-face{font-family:X;src:url(/ff.woff)}</style>'
             when '/m' then '<meta name=referrer content=no-referrer><link rel=stylesheet href=/m.css>'
             when '/top2' then '<iframe src="/mf"></iframe>'
             when '/a1' then '<link rel=stylesheet href=/a1.css><meta name=referrer content=no-referrer><link rel=stylesheet href=/a1b.css>'
             when '/top3' then '<iframe src="/a3"></iframe>'
             when '/he' then '<link id=l rel=preload as=style href=/he1.css><meta name=referrer content=no-referrer><script>l.href = "/he2.css"</script>'
             when '/sd' then '<meta name=referrer content=origin><iframe srcdoc="<link rel=stylesheet href=/sd.css>"></iframe>'
             when '/hd' then '<meta name=referrer content=no-referrer><link id=l rel=stylesheet href=/hd1.css><meta name=referrer content=unsafe-url>' \
                             '<script>l.href = "/hd2.css"</script>'
             when '/a3' then '<meta name=referrer content=no-referrer><link rel=stylesheet href=/a3.css><meta name=referrer content=unsafe-url>' \
                             '<link rel=stylesheet href=/a3b.css><script>1</script>'
             when '/mf' then '<meta name=referrer content=no-referrer><link rel=stylesheet href=/mf.css><script src=/mf.js></script>'
             when '/e' then '<link rel=stylesheet referrerpolicy=no-referrer href=/e.css><script referrerpolicy=origin src=/e.js></script>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
  end

  it "is referred by the frame that requests it" do
    session.visit '/top'
    session.evaluate_script('frames[0].document.fonts.load("16px X")')
    session.evaluate_script('1')
    expect(referers['/top.css']).to eq('http://www.example.com/top')
    expect(referers.slice('/f.css', '/f.js', '/fm.js', '/fi.js', '/ff.woff').values.uniq).to eq(['http://www.example.com/f'])
  end

  it "is referred under its document's policy" do
    session.visit '/m'
    expect(referers).to include('/m.css' => nil)
  end

  # …the policy its document had as the parser inserted it: a `<meta>` after it none of its (Chrome).
  it 'is referred under the policy its document had as it was inserted' do
    session.visit '/a1'
    expect(referers.slice('/a1.css', '/a1b.css')).to eq('/a1.css' => 'http://www.example.com/a1', '/a1b.css' => nil)
    session.visit '/top3'
    expect(referers.slice('/a3.css', '/a3b.css')).to eq('/a3.css' => nil, '/a3b.css' => 'http://www.example.com/a3')
  end

  # …a link of another type alike (a preload); a srcdoc document's its container's, whose policy container it clones;
  # and a fetch an `href` change begins the policy its document has then (Chrome).
  it 'is referred under the policy at insertion for a preload, inherited by srcdoc, current for an href change' do
    session.visit '/he'
    session.visit '/sd'
    session.visit '/hd'
    session.evaluate_script('1')
    expect(referers.slice('/he1.css', '/he2.css', '/sd.css', '/hd1.css', '/hd2.css')).to eq(
      '/he1.css' => 'http://www.example.com/he', '/he2.css' => nil, '/sd.css' => 'http://www.example.com/', '/hd1.css' => nil, '/hd2.css' => 'http://www.example.com/hd'
    )
  end

  # A document's `Referrer-Policy` response header sets its policy container's (HTML "create and initialize a Document
  # object"), the page's and a frame's alike — its subresources and its navigations referring under it (Chrome).
  it "is referred under its document's Referrer-Policy header" do
    refs = referers
    session = simulated_session(lambda {|env|
      path = env['PATH_INFO']
      refs[path] = env['HTTP_REFERER']
      next [200, {'content-type' => 'text/css'}, ['p{}']] if path.end_with?('.css')

      body, headers = case path
                      when '/ph' then ['<link rel=stylesheet href=/ph.css><iframe src="/hf"></iframe>', {'referrer-policy' => 'no-referrer'}]
                      when '/hf' then ['<link rel=stylesheet href=/hf.css>', {'referrer-policy' => 'origin'}]
                      else [path, {}]
                      end
      [200, {'content-type' => 'text/html'}.merge(headers), ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/ph'
    session.execute_script('frames[0].location = "/hfnext"')
    expect(session.evaluate_script('frames[0].location.pathname')).to eq('/hfnext')
    expect(referers.slice('/ph.css', '/hf.css', '/hfnext')).to eq('/ph.css' => nil, '/hf.css' => 'http://www.example.com/', '/hfnext' => 'http://www.example.com/')
  end

  # …a javascript: URL's result document the policy of the document it was evaluated in, which it keeps (HTML "evaluate a
  # javascript: URL").
  it "is referred under the policy a javascript: URL's document keeps" do
    refs = referers
    session = simulated_session(lambda {|env|
      path = env['PATH_INFO']
      refs[path] = env['HTTP_REFERER']
      next [200, {'content-type' => 'text/css'}, ['p{}']] if path.end_with?('.css')

      body = path == '/jt' ? '<iframe src="/ja"></iframe>' : path
      [200, {'content-type' => 'text/html', 'referrer-policy' => 'origin'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/jt'
    session.execute_script(%q{frames[0].location = 'javascript:"<link rel=stylesheet href=/js.css>"'})
    session.evaluate_script('1')
    expect(referers['/js.css']).to eq('http://www.example.com/')
  end

  # A frame's navigation whose response downloads makes no document: the frame stays at the one it is at (HTML).
  it "makes no frame document of a download" do
    session = simulated_session(lambda {|env|
      next [200, {'content-disposition' => 'attachment; filename=x.txt', 'content-type' => 'text/plain'}, ['x']] if env['PATH_INFO'] == '/dl'

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><iframe src="/dl"></iframe>']]
    })
    session.visit '/'
    expect(session.evaluate_script('frames[0].location.href')).to eq('about:blank')
  end

  # A font a sheet's `@font-face` names is a `cors` fetch referred by the rule's style resource base URL (CSS Values 4
  # "fetch a style resource"): an external sheet's location, an `@import`ed one's own — another origin's stripped to its
  # origin by the document's policy — while the `@import` (`no-cors`) is referred by its client, the document.
  it "is referred by the sheet a font's rule is in" do
    refs  = referers
    sites = {}
    session = simulated_session(lambda {|env|
      path = env['PATH_INFO']
      refs[path]  = env['HTTP_REFERER']
      sites[path] = env['HTTP_SEC_FETCH_SITE']
      next [200, {'content-type' => 'font/woff2'}, ['']] if path.end_with?('.woff2')

      css = {
        '/css/a.css' => '@import "/imp/i.css"; @font-face{font-family:A;src:url(/fa.woff2)} @font-face{font-family:C;src:url(/fc.woff2)}',
        '/imp/i.css' => '@font-face{font-family:I;src:url(/fi.woff2)}',
        '/o.css'     => '@font-face{font-family:O;src:url(http://www.example.com/fo.woff2)}'
      }[path]
      next [200, {'content-type' => 'text/css'}, [css]] if css

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><link rel=stylesheet href=/css/a.css>' \
                                              '<link rel=stylesheet href=http://other.test/o.css>' \
                                              '<style>@font-face{font-family:S;src:url(/fs.woff2)}</style>']]
    })
    session.visit '/p'
    session.evaluate_script('Promise.all(["A", "I", "O", "S"].map((f) => document.fonts.load(`16px ${f}`)))')
    # (…a CSS-connected face's own `load()` alike)
    session.evaluate_script('[...document.fonts].find((f) => f.family === "C").load().then(() => 1, () => 1)')
    session.evaluate_script('1')
    expect(referers.slice('/imp/i.css', '/fa.woff2', '/fc.woff2', '/fi.woff2', '/fo.woff2', '/fs.woff2')).to eq(
      '/imp/i.css' => 'http://www.example.com/p',
      '/fa.woff2'  => 'http://www.example.com/css/a.css',
      '/fc.woff2'  => 'http://www.example.com/css/a.css',
      '/fi.woff2'  => 'http://www.example.com/imp/i.css',
      '/fo.woff2'  => 'http://other.test/',
      '/fs.woff2'  => 'http://www.example.com/p'
    )
    expect(sites['/fo.woff2']).to eq('same-origin')
  end

  # A module a script imports is referred by that script's base URL (HTML "fetch the descendants of a module script",
  # HostLoadImportedModule): a static import by its importer's URL, an `import()` by the URL of the script it is in — an
  # inline one's its document's base URL — and a graph's every fetch under the referrer policy its element sets, an
  # `import()` its module makes too (the descendant script fetch options keep it).
  it "is referred by the script that imports it, under its graph's policy" do
    refs = referers
    session = simulated_session(lambda {|env|
      path = env['PATH_INFO']
      refs[path] = env['HTTP_REFERER']
      js = {
        '/m/entry.js'   => 'import "/n/child.js"; import("/n/dyn.js");',
        '/n/child.js'   => 'import "/o/grand.js";',
        '/c/classic.js' => 'import("/n/fromclassic.js");',
        '/r/entry.js'   => 'import "/r/child.js"; import("/r/dyn.js");'
      }[path]
      next [200, {'content-type' => 'text/javascript'}, [js || '']] if path.end_with?('.js')

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><script type=module src=/m/entry.js></script>' \
                                              '<script src=/c/classic.js></script><script>import("/n/frominline.js")</script>' \
                                              '<script type=module referrerpolicy=origin src=/r/entry.js></script>' \
                                              '<script type=module referrerpolicy=no-referrer>window.a = () => import("/i/a.js")</script>' \
                                              '<script type=module>window.b = () => import("/i/b.js")</script>']]
    })
    session.visit '/page/p'
    session.evaluate_script('1')
    session.execute_script('a(); b()')
    session.evaluate_script('1')
    # (…`/i/a.js` aside: an inline module's own `referrerpolicy` its `import()` does not keep yet — the policies are keyed
    # by URL — though no other inline module's leaks into another's: `/i/b.js`)
    expect(referers.except('/page/p', '/i/a.js')).to eq(
      '/m/entry.js'       => 'http://www.example.com/page/p',
      '/n/child.js'       => 'http://www.example.com/m/entry.js',
      '/o/grand.js'       => 'http://www.example.com/n/child.js',
      '/n/dyn.js'         => 'http://www.example.com/m/entry.js',
      '/c/classic.js'     => 'http://www.example.com/page/p',
      '/n/fromclassic.js' => 'http://www.example.com/c/classic.js',
      '/n/frominline.js'  => 'http://www.example.com/page/p',
      '/r/entry.js'       => 'http://www.example.com/',
      '/r/child.js'       => 'http://www.example.com/',
      '/r/dyn.js'         => 'http://www.example.com/',
      '/i/b.js'           => 'http://www.example.com/page/p'
    )
  end

  # …a handler's `import()` by its client, the document — no script refers it (HTML: a handler's function has no
  # [[ScriptOrModule]]) — though it resolves against the document's base URL.
  it "is referred by its document for an event handler's import()" do
    refs = referers
    session = simulated_session(lambda {|env|
      refs[env['PATH_INFO']] = env['HTTP_REFERER']
      next [200, {'content-type' => 'text/javascript'}, ['']] if env['PATH_INFO'].end_with?('.js')

      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><base href="/other/dir/"><button onclick="import(\'./h.js\')">h</button>']]
    })
    session.visit '/page/p'
    session.click_button 'h'
    session.evaluate_script('1')
    expect(referers).to include('/other/dir/h.js' => 'http://www.example.com/page/p')
  end

  it "is referred under a frame's meta policy parsed before it" do
    session.visit '/top2'
    expect(referers.slice('/mf.css', '/mf.js')).to eq('/mf.css' => nil, '/mf.js' => nil)
  end

  # …a frame's whose `<meta name="referrer">` comes before its sheet (its policy taken as the parser inserts it), and a
  # script a document inserts — or another realm's code inserts into it (its node document requesting it).
  it "is referred under a frame's meta policy and by an inserted script's document" do
    session.visit '/top'
    session.execute_script(<<~JS)
      const d = frames[0].document;
      const s = d.createElement('script'); s.referrerPolicy = 'origin'; s.src = '/inj.js'; d.body.append(s);
      const t = document.createElement('script'); t.src = '/pagedyn.js'; document.body.append(t);
    JS
    session.evaluate_script('1')
    expect(referers.slice('/inj.js', '/pagedyn.js')).to eq('/inj.js' => 'http://www.example.com/', '/pagedyn.js' => 'http://www.example.com/top')
  end

  # A font is a CORS request of its client (CSS Fonts 4 §4.9.1): one a frame of the font's origin loads, another origin's
  # document has refused all the same, whichever asked first (Chrome).
  it "keeps a font's CORS verdict its client's origin's" do
    font = File.binread(File.expand_path('fixtures/fonts/Ahem.woff2', __dir__))
    session = simulated_session(lambda {|env|
      next [200, {'content-type' => 'font/woff2'}, [font]] if env['PATH_INFO'] == '/q.woff2'

      body = env['HTTP_HOST'] == 'other.test' ? 'other' : '<iframe src="http://other.test/f"></iframe>'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/'
    load = 'new FontFace("Q", "url(http://other.test/q.woff2)").load().then(() => "ok", (e) => e.name)'
    frame = session.within_frame(0) { session.evaluate_async_script("#{load}.then(arguments[0])") }
    page = session.evaluate_async_script("#{load}.then(arguments[0])")
    expect([frame, page]).to eq(%w[ok NetworkError])
  end

  it "is referred under its element's policy" do
    session.visit '/e'
    expect(referers.slice('/e.css', '/e.js')).to eq('/e.css' => nil, '/e.js' => 'http://www.example.com/')
  end
end
