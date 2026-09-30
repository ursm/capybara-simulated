# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The Rust walk's pass (CSIM_STYLO) puts back the layout of every subtree it built exactly as the last pass did
# (`walk_reuse.rs`): each element's subtree is a chunk of the measure cache, keeping its id for as long as its records,
# runs, grid values and inline entries are the same, positions made its own. A geometry read cannot tell a put-back
# layout from a fresh one, so these count the put-backs — and hold the geometry against a page laid out afresh.
RSpec.describe 'the Rust walk puts back what did not change' do
  around do |example|
    saved = ENV.values_at('CSIM_STYLO', 'CSIM_NL_REUSE_VERIFY')
    ENV['CSIM_STYLO'] = '1'
    ENV['CSIM_NL_REUSE_VERIFY'] = nil
    example.run
  ensure
    ENV['CSIM_STYLO'], ENV['CSIM_NL_REUSE_VERIFY'] = saved
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
        document.getElementById('top').after(document.createElement('hr'));
        document.body.offsetHeight;
        const [p0] = __dom.layoutMeasureCounts();
        edit('s6');
        return __dom.layoutMeasureCounts()[0] - p0;
      })()
    JS
    expect(got).to be >= 55
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
