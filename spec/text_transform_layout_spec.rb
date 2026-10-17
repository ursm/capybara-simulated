# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `text-transform` changes the case the layout measures and paints a run in (CSS Text 3 §2.1), character by character
# where the mapping keeps a character's length — the runs and the DOM's offsets stay one to one, so `ß` is laid out as it
# is where Chrome lays out `SS` — `capitalize` the first letter of each word, a word starting after anything but a
# letter, a digit, an apostrophe or a low line, across an inline box's edge. Each transformed span is as wide as the
# span written in the case it lays out (Chrome: 94.70 = 94.70, 67.97 = 67.97, 180.19 for `Hello World (Fine) Foo-Bar`,
# `Don't`, `3rd`, `X_y`).
RSpec.describe 'text-transform in layout' do
  let(:page) {
    <<~HTML
      <!doctype html><meta charset="utf-8"><body style="margin:0;font:16px serif">
      <div><span id=u style="text-transform:uppercase">upper case</span> <span id=U>UPPER CASE</span></div>
      <div><span id=l style="text-transform:lowercase">LOWER Case</span> <span id=L>lower case</span></div>
      <div><span id=c style="text-transform:capitalize">hello wor<b>ld</b> (fine) foo-bar don't 3rd x_y</span>
        <span id=C>Hello Wor<b>ld</b> (Fine) Foo-Bar Don't 3rd X_y</span></div>
      <div><span id=s style="text-transform:uppercase">straße</span> <span id=S>STRAßE</span></div>
    HTML
  }

  it 'lays a transformed run out in the case it renders' do
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    widths = session.evaluate_script(<<~JS)
      Object.fromEntries(['u', 'U', 'l', 'L', 'c', 'C', 's', 'S'].map((id) => [id, document.getElementById(id).getBoundingClientRect().width]))
    JS
    expect([widths['u'], widths['l'], widths['c'], widths['s']]).to eq([widths['U'], widths['L'], widths['C'], widths['S']])
    expect(session.evaluate_script("document.getElementById('c').innerText")).to eq("Hello World (Fine) Foo-Bar Don't 3rd X_y")
  end
end

# `font-size: 0`: text that takes no room and makes no line taller (the white-space gap between inline-blocks gone).
# Chrome, each [x, y, width, height]: the div 26 tall, the span 0x0 at 20, the inline-blocks at 0 and 30, the `<p>` 0 tall.
RSpec.describe 'font-size: 0 in layout' do
  it 'lays its text out as nothing' do
    page = <<~HTML
      <!doctype html><meta charset="utf-8"><body style="margin:0"><div id=d style="font-size:0;width:400px"><span id=s>hello</span><span id=b style="display:inline-block;width:30px;height:20px;font-size:16px">x</span><span id=b2 style="display:inline-block;width:30px;height:20px"></span></div><p id=p style="font-size:0;margin:0">zero</p>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['d', 's', 'b', 'b2', 'p'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, r.x, r.y, r.width, r.height]; })
    JS
    expect(got).to eq([['d', 0, 0, 400, 26], ['s', 0, 20, 0, 0], ['b', 0, 6, 30, 20], ['b2', 30, 0, 30, 20], ['p', 0, 26, 1024, 0]])
  end
end
