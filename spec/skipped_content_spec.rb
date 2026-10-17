# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/raster'
require 'tmpdir'

# SKIPPED content (CSS Contain 2 §4) — a `content-visibility: hidden` box's contents, a closed `<details>`'s but its
# summary — is laid out and measured as Chrome measures it, but neither painted nor hit nor visible to a finder.
RSpec.describe 'skipped content' do
  let(:page) {
    <<~HTML
      <!doctype html><meta charset="utf-8"><body style="margin:0">
      <div id=h style="content-visibility:hidden;width:200px;height:50px">
        <p id=p style="margin:0;width:120px;height:30px">x</p><img id=i width=100 height=50 style="width:30px">
      </div>
      <details><summary>sum</summary><p id=d style="width:70px;height:10px">y</p></details>
    HTML
  }

  # Chrome: [h 0 0 200 50], [p 0 0 120 30], [i 0 30 30 50] — and checkVisibility() false for both.
  it "measures a content-visibility: hidden box's contents, which are not visible" do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['h', 'p', 'i'].map((id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return [id, r.x, r.y, r.width, r.height, e.checkVisibility()]; })
    JS
    expect(got).to eq([['h', 0, 0, 200, 50, true], ['p', 0, 0, 120, 30, false], ['i', 0, 30, 30, 50, false]])
    expect(session.evaluate_script("document.getElementById('i').width")).to eq(30)
    expect(session.has_css?('#p', wait: 0)).to be(false)
  end

  it 'neither hits nor paints skipped content' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    hits = session.evaluate_script(<<~JS)
      ['p', 'd'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return document.elementFromPoint(r.x + 2, r.y + 2)?.id; })
    JS
    expect(hits).not_to include('p', 'd')
    # (…the skipped boxes painted nothing: their area, a black background each, stays white)
    session.execute_script("for (const id of ['p', 'd']) document.getElementById(id).style.background = 'black'")
    centres = session.evaluate_script(<<~JS)
      ['p', 'd'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })
    JS
    Dir.mktmpdir do |dir|
      path = File.join(dir, 'shot.png')
      session.save_screenshot(path)
      raster = Raster.read(path)
      expect(centres.map {|x, y| raster[x, y].first(3) }).to eq([[255, 255, 255]] * 2)
    end
  end
end
