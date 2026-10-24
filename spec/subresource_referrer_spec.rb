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
             when '/he' then '<link rel=preload as=style href=/he1.css><meta name=referrer content=no-referrer><script>1</script>'
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
    expect(referers.slice('/he1.css', '/sd.css', '/hd1.css', '/hd2.css')).to eq(
      '/he1.css' => 'http://www.example.com/he', '/sd.css' => 'http://www.example.com/', '/hd1.css' => nil, '/hd2.css' => 'http://www.example.com/hd'
    )
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
