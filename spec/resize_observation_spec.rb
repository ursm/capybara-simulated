require 'capybara/simulated'
require_relative 'support/session_teardown'

# A ResizeObserver's gather and its entries read ONE answer (resize_observation.rs): content `content-visibility: hidden`
# skips is not laid out, so its sizes are 0 by 0 for both — when the gather measured its box and the entry did not, the
# observation never settled and reported a loop every frame. A page-set `devicePixelRatio` is no ratio of the display's at
# all: its device pixels are the engine's (viewport.rs `DEVICE_PIXEL_RATIO`), whatever the page writes.
RSpec.describe 'Resize observations' do
  let(:html) {
    <<~'HTML'
      <!doctype html><meta charset=utf-8><body>
      <div style="content-visibility:hidden"><div id=cv style="width:10px;height:10px"></div></div>
      <div id=a style="width:10px;height:7px"></div>
      <script>
        window.calls = 0; window.errors = 0;
        addEventListener('error', () => errors++);
        new ResizeObserver(() => calls++).observe(cv);
        window.devicePixelRatio = -2;
        new ResizeObserver(() => calls++).observe(a, {box: 'device-pixel-content-box'});
        let frames = 0; const f = () => { if (++frames < 10) requestAnimationFrame(f); else document.body.append(Object.assign(document.createElement('p'), {id: 'done'})); }; requestAnimationFrame(f);
      </script>
    HTML
  }
  let(:session) { simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] }) }

  it 'settles an observation of skipped content, and of a device-pixel box at a ratio that is none' do
    session.visit '/'
    expect(session).to have_css('#done')
    expect(session.evaluate_script('[calls, errors]')).to eq([2, 0])
  end

  # The device-pixel-content-box is in the display's device pixels, whatever `devicePixelRatio` a page writes over the
  # Window's (Replaceable) getter: one a CSS pixel here.
  it 'measures a device-pixel box in the display\'s pixels, not a page-written ratio' do
    s = simulated_session(->(_) { [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><div id=a style="width:10px;height:7px"></div>']] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      window.devicePixelRatio = 2;
      new ResizeObserver(([e]) => done([e.devicePixelContentBoxSize[0].inlineSize, e.devicePixelContentBoxSize[0].blockSize, devicePixelRatio]))
        .observe(a, {box: 'device-pixel-content-box'});
    JS
    expect(got).to eq([10, 7, 2])
  end
end
