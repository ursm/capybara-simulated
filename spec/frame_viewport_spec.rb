require 'capybara/simulated'
require 'rack'
require_relative 'support/js_engine'
require_relative 'support/session_teardown'

# A nested browsing context's viewport is its container's content box — not the top window's. That
# is what makes a responsive component inside a narrow frame take its narrow branch, and it has to
# be true from the frame's very first script: everything here is what real Chrome reports for the
# same markup (read back with `--headless --dump-dom` over http, window 1024x768).
RSpec.describe 'frame viewport' do
  before { skip 'per-frame realms need the V8 engine' unless CsimEngine.v8? }

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
end
