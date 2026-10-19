require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/garbage'

# Media queries are matched by ONE evaluator, the style engine's (style.rs `media_matches`): the `@media` rules the
# cascade applies, `matchMedia`, a `<style media>` / `<link media>`, and a `<picture>`'s `<source media>` all ask it, so a
# script branch and the CSS it pairs with cannot disagree. (`matchMedia` had an evaluator of its own, which knew a
# dozen features and called a viewport 700px wide or less a touchscreen while the cascade said it had a mouse.)
RSpec.describe 'media queries' do
  PAGE = <<~HTML.freeze
    <!DOCTYPE html><html><head><style>
      #hover { display: none } @media (hover: hover) { #hover { display: block } }
      #coarse { display: none } @media (pointer: coarse) { #coarse { display: block } }
      #range { display: none } @media (500px <= width <= 2000px) { #range { display: block } }
    </style>
    <style media="(max-width: 300px)">#narrow { color: rgb(1, 2, 3) }</style>
    </head><body>
      <div id="hover">h</div><div id="coarse">c</div><div id="range">r</div><div id="narrow">n</div>
      <picture>
        <source media="(max-width: 300px)" srcset="/small.png">
        <img id="img" src="/big.png">
      </picture>
    </body></html>
  HTML

  def session(mode = :simulated)
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [PAGE]] }, mode: mode).tap {|s| s.visit '/' }
  end

  def answers(s)
    s.evaluate_script(<<~JS)
      (() => {
        const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
        const mm = (q) => matchMedia(q).matches;
        return {
          css:   [shown('hover'), shown('coarse'), shown('range'), getComputedStyle(document.getElementById('narrow')).color],
          query: [mm('(hover: hover)'), mm('(pointer: coarse)'), mm('(500px <= width <= 2000px)'), mm('(max-width: 300px)')],
          any:   [mm('(any-hover: hover)'), mm('(any-pointer: fine)')],
          img:   document.getElementById('img').currentSrc.split('/').pop()
        };
      })()
    JS
  end

  it 'answers a mouse session alike in CSS and script, at any width' do
    s = session
    expect(answers(s)).to eq('css' => [true, false, true, 'rgb(0, 0, 0)'], 'query' => [true, false, true, false],
                             'any' => [true, true], 'img' => 'big.png')
    # (…a narrow window is still a desktop's: Chrome with a mouse at 280px wide hovers, and its pointer is fine. The image
    # keeps the source it was loaded from: re-selecting one on a viewport change is not modelled.)
    s.current_window.resize_to(280, 600)
    expect(answers(s)).to eq('css' => [true, false, false, 'rgb(1, 2, 3)'], 'query' => [true, false, false, true],
                             'any' => [true, true], 'img' => 'big.png')
  end

  it 'answers a touch session (`touch: true`, Playwright\'s hasTouch) as a touchscreen' do
    Capybara.register_driver(:simulated_touch) {|app| Capybara::Simulated::Driver.new(app, touch: true) }
    s = session(:simulated_touch)
    touch = {'css' => [false, true, true, 'rgb(0, 0, 0)'], 'query' => [false, true, true, false], 'any' => [false, false],
             'img' => 'big.png'}
    expect(answers(s)).to eq(touch)
    # (…the session's, in every window it opens)
    s.within_window(s.open_new_window) do
      s.visit '/'
      expect(answers(s)).to eq(touch)
    end
  end

  it 'serializes a MediaQueryList\'s media' do
    s = session
    expect(s.evaluate_script("matchMedia('(MIN-WIDTH:100px)').media")).to eq('(min-width: 100px)')
  end

  # "Evaluate media queries and report changes" (CSSOM View §4.2) tells each list whose answer flipped, oldest first,
  # once a flip. The engine holds a list weakly but for while it has a `change` listener: one the page keeps only through
  # its listener still hears, one it dropped is let go of — where every list `matchMedia` ever made was kept.
  it 'tells a list of each flip, kept by its `change` listener alone, and lets go of one nothing holds' do
    s = session
    s.execute_script(<<~JS)
      window.__heard = [];
      matchMedia('(max-width: 300px)').addEventListener('change', (e) => __heard.push(['narrow', e.matches, e.media]));
      matchMedia('(min-width: 400px)').onchange = (e) => __heard.push(['wide', e.matches]);
      matchMedia('(max-width: 300px)').addEventListener('change', (e) => __heard.push(['once', e.matches]), {once: true});
      window.__dropped = new WeakRef(matchMedia('(max-width: 300px)'));
    JS
    collect_garbage(s) { s.evaluate_script('__dropped.deref() === undefined') }
    s.current_window.resize_to(280, 600)
    s.current_window.resize_to(290, 600)
    s.current_window.resize_to(1024, 768)
    expect(s.evaluate_script('[__heard, __dropped.deref() === undefined]')).to eq(
      [
        [
          ['narrow', true, '(max-width: 300px)'],
          ['wide', false],
          ['once', true],
          ['narrow', false, '(max-width: 300px)'],
          ['wide', true]
        ],
        true
      ]
    )
  end
end
