require 'capybara/simulated'
require_relative 'support/session_teardown'

# A ResizeObserver's gather and its entries read ONE answer (resize_observation.rs): content `content-visibility: hidden`
# skips is not laid out, so its sizes are 0 by 0 for both — when the gather measured its box and the entry did not, the
# observation never settled and reported a loop every frame. A page-set `devicePixelRatio` that is no ratio is 1 alike.
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
end
