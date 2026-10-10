require 'capybara/simulated'
require_relative 'support/session_teardown'

# IntersectionObserver's geometry (intersection.rs): a target's box clipped by every box between it and the root that
# clips its overflow, then by the root rectangle — a root element's PADDING box where it clips (its border box was used),
# grown by the margin, percentages of its size. Every figure Chrome's (2026-10-10); the viewport size aside (Chrome's
# window here was 800x457). Not compared: an ancestor with `overflow-x: hidden` alone, whose computed `overflow-y: auto`
# gives Chrome a classic scrollbar this engine does not model.
RSpec.describe 'Intersection geometry' do
  let(:html) {
    <<~'HTML'
      <!doctype html><meta charset=utf-8><style>body{margin:0}
      #s{position:absolute;left:20px;top:20px;width:100px;height:100px;overflow:hidden;border:10px solid;padding:5px}
      #t{width:50px;height:50px;margin-left:80px;margin-top:20px}
      .c{position:absolute;width:40px;height:40px} .c div{width:20px;height:80px;margin-left:30px}</style>
      <div id=s><div id=t></div></div>
      <div class=c style="left:300px;top:10px;overflow:hidden"><div id=h></div></div>
      <div class=c style="left:500px;top:10px;overflow:clip"><div id=k></div></div>
      <script>
        const r = (b) => [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100).join(',');
        window.res = {};
        const mk = (name, el, opts) => new IntersectionObserver((es) => {
          const e = es[0]; res[name] = [r(e.intersectionRect), e.rootBounds && r(e.rootBounds), Math.round(e.intersectionRatio * 1000) / 1000];
        }, opts).observe(el);
        mk('implicit', t, {}); mk('root', t, {root: s}); mk('margin', t, {root: s, rootMargin: '10% 0px'});
        mk('hidden', h, {}); mk('clip', k, {});
      </script>
    HTML
  }
  let(:session) { simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] }) }

  it 'clips a target by the boxes up to its root, against the root padding box' do
    session.visit '/'
    expect(session.evaluate_script('Object.keys(res).length')).to eq(5)
    got = session.evaluate_script('res')
    expect(got['implicit'][0]).to eq('115,55,25,50')
    expect(got['root']).to eq(['115,55,25,50', '30,30,110,110', 0.5])
    expect(got['margin']).to eq(['115,55,25,50', '30,19,110,132', 0.5])
    expect([got['hidden'][0], got['clip'][0]]).to eq(['330,10,10,40', '530,10,10,40'])
  end
end
