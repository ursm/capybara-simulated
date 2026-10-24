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
