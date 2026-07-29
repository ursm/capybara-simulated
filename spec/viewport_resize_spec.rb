require 'capybara/simulated'
require 'rack'
require_relative 'support/js_engine'

# Resizing the window moves ONE viewport: `innerWidth` / `innerHeight`, the
# `@media` cascade, `matchMedia()`, and the layout the geometry surface reports
# all read the same size. Before this, layout laid out against a hardcoded
# 1024x768 while everything else followed the resize, so a mobile-breakpoint
# test saw the breakpoint flip but measured desktop boxes.
RSpec.describe 'window resize' do
  # A page whose box is viewport-relative (percentage width, `position: fixed`
  # pinned to the bottom-right) plus a breakpoint that only a narrow window hits.
  def body
    <<~HTML
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0 }
        #half { width: 50%; height: 40px }
        #pinned { position: fixed; right: 0; bottom: 0; width: 30px; height: 20px }
        #mobile-only { display: none }
        @media (max-width: 600px) { #mobile-only { display: block } }
      </style></head><body>
        <div id="half"></div>
        <div id="pinned"></div>
        <div id="mobile-only">narrow</div>
      </body></html>
    HTML
  end

  def session
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  it 'reports the resized size through the window, screen and Capybara surfaces' do
    s = session
    expect(s.current_window.size).to eq([1024, 768])

    s.current_window.resize_to(480, 900)

    expect(s.current_window.size).to eq([480, 900])
    expect(s.evaluate_script('[innerWidth, innerHeight]')).to eq([480, 900])
    # outerWidth/Height are derived, so they follow instead of freezing at the
    # size the page was built with.
    expect(s.evaluate_script('[outerWidth, outerHeight]')).to eq([480, 900])
    expect(s.evaluate_script('[visualViewport.width, visualViewport.height]')).to eq([480, 900])
    # `screen` is the DISPLAY: a window resize doesn't move it.
    expect(s.evaluate_script('[screen.width, screen.height]')).to eq([1024, 768])
  end

  it 'lays out against the resized viewport' do
    s = session
    expect(s.evaluate_script("document.getElementById('half').getBoundingClientRect().width")).to eq(512)
    expect(s.evaluate_script("document.documentElement.clientWidth")).to eq(1024)

    s.current_window.resize_to(480, 900)

    # Percentage width resolves against the new initial containing block...
    expect(s.evaluate_script("document.getElementById('half').getBoundingClientRect().width")).to eq(240)
    # ...the root's clientWidth/Height is the viewport (the CSSOM rule)...
    expect(s.evaluate_script('[document.documentElement.clientWidth, document.documentElement.clientHeight]')).to eq([480, 900])
    # ...and a fixed box pinned to the far corner moves with it.
    rect = s.evaluate_script("(r => [r.right, r.bottom])(document.getElementById('pinned').getBoundingClientRect())")
    expect(rect).to eq([480, 900])
  end

  it 'agrees between the breakpoint and the boxes it reveals' do
    s = session
    expect(s).to have_no_css('#mobile-only', visible: true)

    s.current_window.resize_to(480, 900)

    expect(s).to have_css('#mobile-only', text: 'narrow')
    # The revealed element is laid out (not a zero box), and it is clickable
    # where it is — the breakpoint and the geometry ran against one viewport.
    expect(s.find('#mobile-only').rect['width']).to eq(480)
    expect(s.find('#mobile-only')).not_to be_obscured
  end

  it 'keeps the viewport out of page script\'s reach ([Replaceable])' do
    s = session
    # `innerWidth` & co are `[Replaceable]`: assigning replaces the accessor with a plain own
    # property — it must not throw (strict-mode device-emulation shims do exactly this)...
    s.execute_script("'use strict'; window.innerWidth = 400; window.outerWidth = 400")
    expect(s.evaluate_script('innerWidth')).to eq(400)
    # ...and it must not move the driver's viewport out from under the layout engine, the way a
    # real browser doesn't.
    expect(s.evaluate_script("document.getElementById('half').getBoundingClientRect().width")).to eq(512)
    expect(s.current_window.size).to eq([1024, 768])
  end

  it 'mirrors the Ruby-side display constant' do
    # Two hand-kept copies of the display size (js/src/platform-globals.js and Browser::SCREEN_SIZE);
    # this is what stops them drifting.
    expect(session.evaluate_script('[screen.width, screen.height]'))
      .to eq(Capybara::Simulated::Browser::SCREEN_SIZE)
  end

  it 'maximize / fullscreen restore the display size' do
    s = session
    s.current_window.resize_to(480, 900)
    expect(s.current_window.size).to eq([480, 900])

    s.current_window.maximize
    expect(s.current_window.size).to eq([1024, 768])
    expect(s.evaluate_script("document.getElementById('half').getBoundingClientRect().width")).to eq(512)

    s.current_window.resize_to(480, 900)
    s.current_window.fullscreen
    expect(s.current_window.size).to eq([1024, 768])
  end

  it 'restores a mobile-configured driver to ITS viewport, not the desktop display' do
    # A driver built with a viewport is a mobile session; `maximize` must not silently promote it
    # to desktop and flip every breakpoint for the rest of the test.
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    Capybara.register_driver(:simulated_mobile_probe) {|a| Capybara::Simulated::Driver.new(a, viewport: [425, 694]) }
    s = Capybara::Session.new(:simulated_mobile_probe, app)
    s.visit '/'
    expect(s.current_window.size).to eq([425, 694])

    s.current_window.resize_to(1024, 768)
    s.current_window.maximize

    expect(s.current_window.size).to eq([425, 694])
  end

  it 'carries the resize into a frame, which lays out against its container' do
    skip 'per-frame realms need the V8 engine' unless CsimEngine.v8?

    frame_body = '<!DOCTYPE html><html><head><style>body{margin:0} #i{width:100%;height:10px}</style>' \
                 '</head><body><div id="i"></div></body></html>'
    app = lambda {|env|
      html = env['PATH_INFO'] == '/frame' ? frame_body : '<!DOCTYPE html><html><body style="margin:0">' \
             '<iframe src="/frame" style="width:50%;height:200px;border:0"></iframe></body></html>'
      [200, {'content-type' => 'text/html'}, [html]]
    }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s.within_frame(0) { expect(s.evaluate_script("document.getElementById('i').getBoundingClientRect().width")).to eq(512) }

    s.current_window.resize_to(400, 300)

    # The container is now 200 wide, so the frame's own viewport — and the 100%-wide box in it — is
    # 200. Without the re-push the frame would still measure 512.
    s.within_frame(0) { expect(s.evaluate_script("document.getElementById('i').getBoundingClientRect().width")).to eq(200) }
  end
end
