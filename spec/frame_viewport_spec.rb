require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A nested browsing context's viewport is its container's content box — not the top window's. That
# is what makes a responsive component inside a narrow frame take its narrow branch, and it has to
# be true from the frame's very first script: everything here is what real Chrome reports for the
# same markup (read back with `--headless --dump-dom` over http, window 1024x768).
RSpec.describe 'frame viewport' do
  CHILD = <<~HTML
    <!DOCTYPE html>
    <html><head><style>
      body { margin: 0 }
      #r { width: 100%; height: 10px }
      #narrow { display: none }
      @media (max-width: 400px) { #narrow { display: block } }
    </style></head><body>
      <div id="r"></div><div id="narrow">N</div>
      <script>window.__atLoad = innerWidth + 'x' + innerHeight;</script>
    </body></html>
  HTML

  def session(parent_body)
    app = lambda {|env|
      body = env['PATH_INFO'] == '/child' ? CHILD : parent_body
      [200, {'content-type' => 'text/html'}, [body]]
    }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  def framed(frame_style = 'width:300px;height:150px;border:0')
    session(%(<!DOCTYPE html><html><body style="margin:0"><iframe src="/child" style="#{frame_style}"></iframe></body></html>))
  end

  it 'reports the container box as the frame window\'s size' do
    s = framed
    s.within_frame(0) do
      expect(s.evaluate_script('[innerWidth, innerHeight]')).to eq([300, 150])                    # Chrome: 300x150
      expect(s.evaluate_script('document.documentElement.clientWidth')).to eq(300)                # Chrome: 300
      expect(s.evaluate_script("document.getElementById('r').getBoundingClientRect().width")).to eq(300)
    end
  end

  it 'has the frame size already at load time' do
    # Seeded BEFORE the frame's document loads — a component that measures itself in a load-time
    # script (the common case) must not see the top window's size. Chrome: 300x150.
    s = framed
    s.within_frame(0) { expect(s.evaluate_script('window.__atLoad')).to eq('300x150') }
  end

  it 'evaluates the frame\'s own media queries against it' do
    s = framed
    s.within_frame(0) do
      expect(s.evaluate_script("matchMedia('(max-width: 400px)').matches")).to be(true)   # Chrome: true
      expect(s).to have_css('#narrow', text: 'N')                                        # revealed by the frame-width breakpoint
    end
    # The same page at the top level is 1024 wide, so the breakpoint does NOT fire there.
    top = session(CHILD)
    expect(top.evaluate_script("matchMedia('(max-width: 400px)').matches")).to be(false)
    expect(top).to have_no_css('#narrow', visible: true)
  end

  it 'reports an unrendered frame as a zero viewport' do
    # Chrome: a `display: none` iframe's window is 0x0 — and nothing inside it is clickable. Read
    # through `contentWindow` (as the Chrome probe did): Capybara can't switch into a hidden frame.
    s = framed('display:none')
    expect(s.evaluate_script("(w => [w.innerWidth, w.innerHeight])(document.querySelector('iframe').contentWindow)")).to eq([0, 0])
  end

  it 'follows a window resize' do
    s = framed('width:50%;height:200px;border:0')
    s.within_frame(0) { expect(s.evaluate_script('innerWidth')).to eq(512) }

    s.current_window.resize_to(400, 300)

    s.within_frame(0) do
      expect(s.evaluate_script('innerWidth')).to eq(200)
      # The narrower container crosses the frame's own breakpoint.
      expect(s.evaluate_script("matchMedia('(max-width: 400px)').matches")).to be(true)
      expect(s).to have_css('#narrow', text: 'N')
    end
  end

  # A container a SCRIPT resizes gives its frame the new viewport at the next rendering update (HTML's resize steps), and
  # the frame's window fires `resize`: its media queries and its layout follow (Chrome: 300, and `(min-width: 250px)`
  # matching, after a 200px frame is made 300px).
  it 'follows its container when a script resizes it' do
    s = framed('width:200px;height:80px;border:10px solid')
    s.within_frame(0) do
      expect(s.evaluate_script('innerWidth')).to eq(200)
      s.execute_script("window.__resized = 0; addEventListener('resize', () => window.__resized++)")
    end
    s.execute_script("document.querySelector('iframe').style.width = '300px'")
    s.evaluate_script('__runLoopStep(50, 50, false)')   # (…the rendering update)
    s.within_frame(0) do
      expect(s.evaluate_script('[innerWidth, document.documentElement.clientWidth]')).to eq([300, 300])
      expect(s.evaluate_script("matchMedia('(min-width: 250px)').matches")).to be(true)
      expect(s.evaluate_script("document.getElementById('r').getBoundingClientRect().width")).to eq(300)
      expect(s.evaluate_script('window.__resized')).to eq(1)
    end
  end

  # A transform draws the frame elsewhere and sizes no viewport (Chrome: a 200x80 frame under `scale(0.5)` keeps an
  # `innerWidth` of 200).
  it 'is not resized by a transform on its container' do
    s = framed('width:200px;height:80px;border:0;transform:scale(0.5)')
    s.within_frame(0) { expect(s.evaluate_script('[innerWidth, innerHeight]')).to eq([200, 80]) }
  end

  # A frame that navigates gets a NEW realm, and the container's box has to be seeded into it as into the first: the
  # rebuild passed nothing, so after `click_link` inside a frame its window was 0x0 and a block in it 0 wide — and its
  # `frameElement` null. Which is the container from the document's first script on, in either build (Chrome).
  it 'keeps the container box across a navigation inside the frame' do
    pages = {
      '/' => '<!DOCTYPE html><body style="margin:0"><iframe src="/a" style="width:300px;height:150px;border:0"></iframe></body>',
      '/a' => '<!DOCTYPE html><body style="margin:0"><script>window.atLoad = frameElement && frameElement.localName</script><a href="/b">next</a></body>',
      '/b' => '<!DOCTYPE html><body style="margin:0"><script>window.atLoad = frameElement && frameElement.localName</script><div id="d">b</div></body>'
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    s.within_frame(0) do
      expect(s.evaluate_script('window.atLoad')).to eq('iframe')
      s.click_link 'next'
      expect(s.evaluate_script('window.atLoad')).to eq('iframe')
      expect(s.evaluate_script("[innerWidth, innerHeight, document.getElementById('d').getBoundingClientRect().width]")).to eq([300, 150, 300])
      expect(s.evaluate_script('frameElement && frameElement.localName')).to eq('iframe')
    end
  end

  # The body of a framed document takes its margins from the frame's `marginwidth` / `marginheight` where it declares
  # none (HTML §15.3.2) — and as they change. Chrome: `<iframe marginheight=7 marginwidth=3>` puts the body's first
  # child at (3, 7).
  it "gives the framed body its container's marginwidth and marginheight" do
    pages = {
      '/' => '<!DOCTYPE html><body style="margin:0"><iframe id="f" src="/a" marginheight="7" marginwidth="3"></iframe></body>',
      '/a' => '<!DOCTYPE html><body><div id="d">a</div></body>'
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    position = -> { s.within_frame(0) { s.evaluate_script("(r => [r.x, r.y])(document.getElementById('d').getBoundingClientRect())") } }
    expect(position.call).to eq([3, 7])
    s.execute_script("document.getElementById('f').setAttribute('marginwidth', '12')")
    expect(position.call).to eq([12, 7])
  end

  # …but only to a document of its container's origin: a sandboxed one (an opaque origin) sees null, as a cross-origin
  # one does (HTML §7.2.3.4) — while it loads too — and no page writes it (Chrome: a strict-mode write throws).
  it 'hides frameElement from a sandboxed document and lets no page write it' do
    kid = '<!DOCTYPE html><body><script>window.atLoad = String(frameElement)</script></body>'
    pages = {
      '/' => '<!DOCTYPE html><body><iframe id="s" sandbox="allow-scripts" src="/kid"></iframe><iframe id="o" src="/kid"></iframe></body>',
      '/kid' => kid
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    s.within_frame('s') { expect(s.evaluate_script('[window.atLoad, String(frameElement)]')).to eq(%w[null null]) }
    s.within_frame('o') do
      expect(s.evaluate_script('window.atLoad')).to eq('[object HTMLIFrameElement]')
      expect(s.evaluate_script("(() => { 'use strict'; try { window.frameElement = 5; return 'wrote'; } catch (e) { return e.name; } })()")).to eq('TypeError')
      expect(s.evaluate_script('frameElement.id')).to eq('o')
    end
  end
end
