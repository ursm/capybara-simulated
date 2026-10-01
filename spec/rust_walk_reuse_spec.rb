# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The Rust walk's pass puts back the layout of every subtree it built exactly as the last pass did
# (`walk_reuse.rs`): each element's subtree is a chunk of the measure cache, keeping its id for as long as its records,
# runs, grid values and inline entries are the same, positions made its own. A geometry read cannot tell a put-back
# layout from a fresh one, so these count the put-backs — and hold the geometry against a page laid out afresh.
RSpec.describe 'the Rust walk puts back what did not change' do
  around do |example|
    saved = ENV['CSIM_NL_REUSE_VERIFY']
    ENV['CSIM_NL_REUSE_VERIFY'] = nil
    example.run
  ensure
    ENV['CSIM_NL_REUSE_VERIFY'] = saved
  end

  def session(body)
    html = "<!DOCTYPE html><html><head><style>body { margin: 0 } .r { padding: 2px } </style></head><body>#{body}</body></html>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    s
  end

  ROWS = (1..60).map {|i| %(<div class="r"><p><span id="s#{i}">row #{i}</span> <b>x</b></p></div>) }.join

  # Every row an edit did not touch is put back; the edited one, and the ancestors whose subtree it is in, are not.
  it 'puts back the rows an edit did not touch' do
    s = session(%(<div id="top">top</div><div id="l">#{ROWS}</div>))
    got = s.evaluate_script(<<~JS)
      (() => {
        const edit = (id) => { document.getElementById(id).firstChild.data += '!'; document.body.offsetHeight; };
        document.body.offsetHeight;
        for (const id of ['s3', 'top', 's4', 'top']) edit(id);
        const [p0] = __dom.layoutMeasureCounts(), passes = __csimNativeLayoutStats().rust;
        edit('s5');
        return [__dom.layoutMeasureCounts()[0] - p0, __csimNativeLayoutStats().rust - passes];
      })()
    JS
    expect(got[1]).to eq(1)                  # …laid out by the Rust walk's pass, or the count says nothing
    expect(got[0]).to be >= 55
  end

  # …and not WALKED again either: a row whose flat subtree nothing changed in since the last pass (its stamp), whose
  # walk reads nothing outside it that moved, is spliced back from that pass — each of the rows but the edited one, two
  # records apiece.
  it 'splices back the rows an edit did not touch' do
    s = session(%(<div id="top">top</div><div id="l">#{ROWS}</div>))
    got = s.evaluate_script(<<~JS)
      (() => {
        const edit = (id) => { document.getElementById(id).firstChild.data += '!'; document.body.offsetHeight; };
        document.body.offsetHeight;
        for (const id of ['s3', 'top']) edit(id);
        const spliced = () => __dom.layoutMeasureCounts()[3];
        const n0 = spliced();
        edit('s5');
        return spliced() - n0;
      })()
    JS
    expect(got).to be >= 2 * 58
  end

  # …and a row REMOVED is a change to the list, not to the rows after it: each moves up a place in its parent's children,
  # which the arena keeps an index of — rewritten as a change of each row, every row after the removed one was walked
  # again rather than spliced back. Taking one from the middle of the list or adding one before it walks the list, its
  # ancestors and nothing of the rows.
  it 'splices back the rows after one removed from the list, and those after one inserted before them' do
    s = session(%(<div id="top">top</div><div id="l">#{ROWS}</div>))
    got = s.evaluate_script(<<~JS)
      (() => {
        const walked = (change) => {
          document.body.offsetHeight;
          const w0 = __dom.layoutMeasureCounts()[4];
          change();
          document.body.offsetHeight;
          return __dom.layoutMeasureCounts()[4] - w0;
        };
        const row = (id) => document.getElementById(id).parentNode.parentNode;
        return [walked(() => row('s30').remove()), walked(() => row('s5').before(document.createElement('div')))];
      })()
    JS
    expect(got[0]).to be <= 4
    expect(got[1]).to be <= 5
  end

  # …and a box inserted before the list moves every row's records, which is no change to any row: each keeps its chunk
  # through the insertion — and is measured afresh there only because it now stands elsewhere in its formatting context
  # (a measure is keyed on that) — so the next edit in the list puts every other row back. (A row that lost its chunk
  # would be new there, and not kept until the pass after.)
  it 'puts back the rows of a list something was inserted before' do
    s = session(%(<div id="top">top</div><div id="l">#{ROWS}</div>))
    got = s.evaluate_script(<<~JS)
      (() => {
        const edit = (id) => { document.getElementById(id).firstChild.data += '!'; document.body.offsetHeight; };
        document.body.offsetHeight;
        for (const id of ['s3', 'top', 's4', 'top']) edit(id);
        // (…put back, and how many measures the pass had to keep afresh: a row put back whole keeps none, where a row
        // measured again keeps its own — and puts back its paragraph, which counts the same as the row would)
        const delta = (edit_id) => {
          const [p0, k0] = __dom.layoutMeasureCounts();
          edit(edit_id);
          const [p1, k1] = __dom.layoutMeasureCounts();
          return [p1 - p0, k1 - k0];
        };
        document.getElementById('top').after(document.createElement('hr'));
        document.body.offsetHeight;
        const hr = delta('s6');
        // …a GRID too, which puts values in the grid stream every later record's key must not depend on (a record that
        // is no grid's or table's names no place in it)
        const t = document.createElement('div');
        t.style.cssText = 'display: grid; grid-template-columns: 1fr 2fr';
        t.innerHTML = '<i>a</i><i>b</i>';
        document.getElementById('top').after(t);
        document.body.offsetHeight;
        return [hr, delta('s7')];
      })()
    JS
    expect(got.map(&:first).min).to be >= 55
    expect(got.map(&:last).max).to be <= 10                  # …the rows' own measures, not their paragraphs'
  end

  # A web font arriving through `document.fonts` changes no node and no style — what it moves is the face generation —
  # so a subtree nothing else changed in would be spliced back with its text measured in the fallback face: a pass under
  # another generation splices nothing from the last. (Ahem: every glyph 1em, 20 glyphs at 16px.)
  it 'measures an untouched subtree in a web font that arrives through document.fonts' do
    ahem = File.binread(File.expand_path('wpt/fonts/Ahem.ttf', __dir__))
    html = <<~HTML
      <!DOCTYPE html><html><body style="margin:0;font:16px/20px sans-serif">
      <div><div><span id="s" style="font-family: 'Webby', serif">mmmmmmmmmm iiiiiiiii</span></div></div>
      <div id="other">o</div></body></html>
    HTML
    s = simulated_session(->(env) { env['PATH_INFO'] == '/f.ttf' ? [200, {'content-type' => 'font/ttf'}, [ahem]] : [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const warm = () => { for (let i = 0; i < 3; i++) { document.getElementById('other').firstChild.data += '!'; document.body.offsetHeight; } };
      document.body.offsetHeight; warm();
      const f = new FontFace('Webby', 'url(/f.ttf)');
      document.fonts.add(f);
      f.load().then(() => { warm(); done(document.getElementById('s').getBoundingClientRect().width); });
    JS
    expect(got).to eq(320)
  end

  # A record names its comparison functions by their offset in the realm's math table, and the offset has to name the
  # same program from pass to pass: a table built afresh per pass put `min(50%, 150px)` where `min(50%, 120px)` had
  # been, the record looked unchanged, and the width measured for the one was put back for the other (Chrome: 100,
  # 120, 100, 120, 150; the put-back said 120 three times over).
  it 'measures a box again when only the constants of its min() moved' do
    s = session(%(<div style="width:400px"><div id="r"><div id="b" style="width:min(50%, 100px)">b</div><span>t</span></div></div>))
    got = s.evaluate_script(<<~JS)
      (() => {
        const b = document.getElementById('b'), w = () => b.getBoundingClientRect().width;
        const out = [w()];
        for (const v of ['min(50%, 120px)', 'min(50%, 100px)', 'min(50%, 120px)', 'min(50%, 150px)']) { b.style.width = v; out.push(w()); }
        return out;
      })()
    JS
    expect(got).to eq([100, 120, 100, 120, 150])
  end

  # What is put back is what laying it out afresh gives: every row's box after a run of edits, against a page that
  # starts from where the edits left it.
  it 'lays out as a fresh page would' do
    script = <<~JS
      (() => {
        const edit = (id, t) => { document.getElementById(id).firstChild.data = t; document.body.offsetHeight; };
        document.body.offsetHeight;
        edit('s3', 'a much longer row three, long enough to wrap in a narrow box '.repeat(3));
        edit('top', 'top!');
        edit('s3', 'short');
        edit('s9', 'nine '.repeat(40));
        document.getElementById('l').style.width = '300px';
        document.body.offsetHeight;
        edit('s10', 'ten');
        return [...document.querySelectorAll('span, p, .r')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(','); });
      })()
    JS
    edited = session(%(<div id="top">top</div><div id="l">#{ROWS}</div>)).evaluate_script(script)
    fresh = session(%(<div id="top">top</div><div id="l">#{ROWS}</div>))
    fresh.execute_script('globalThis.__csimNativeLayoutVerifyReuse = true')
    expect(fresh.evaluate_script(script)).to eq(edited)
  end
end
