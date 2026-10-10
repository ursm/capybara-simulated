require 'capybara/simulated'
require_relative 'support/session_teardown'

# The boxes that keep a scroll offset, the engine's (scroll_boxes.rs): a quirks-mode document's scrolling element is its
# body where the body is not potentially scrollable in either axis — the parent's `clip` taken for `hidden` (CSSOM View)
# — else none; and a body whose overflow went to the viewport keeps no offset of its own.
RSpec.describe 'Scroll boxes' do
  # Chrome 2026-10-10, and Firefox for `overflow: clip` and `display: contents`: null, body, null, body, null, body — a
  # `display: contents` body has no box, so it is no potentially scrollable one.
  {
    'html{overflow:hidden}body{overflow:auto}'               => nil,
    'html{overflow:hidden}body{overflow:auto;display:none}'  => 'body',
    'html{overflow:clip}body{overflow:auto}'                 => nil,
    'body{overflow:auto}'                                    => 'body',
    'html{overflow-x:hidden}body{overflow-y:auto}'           => nil,
    'html{overflow:hidden}body{overflow:auto;display:contents}' => 'body'
  }.each do |css, expected|
    it "takes #{expected || 'none'} for the scrolling element of a quirks-mode document with #{css}" do
      html    = "<html><head><style>#{css}</style></head><body>x</body></html>"
      session = simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] })
      session.visit '/'
      got = session.evaluate_script('[document.compatMode, document.scrollingElement && document.scrollingElement.localName]')
      expect(got).to eq(['BackCompat', expected])
    end
  end

  it 'keeps an offset on a scroll container and none on the body whose overflow the viewport took' do
    html = <<~HTML
      <!doctype html><meta charset=utf-8>
      <style>body{overflow:auto}#s{overflow:auto;height:50px}#v{height:50px}span{overflow:auto}</style>
      <div id=s><div style="height:500px"></div></div><div id=v><div style="height:500px"></div></div><span id=i>x</span>
    HTML
    session = simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      [s, v, i, document.body].map((el) => { el.scrollTop = 30; return el.scrollTop; })
    JS
    expect(got).to eq([30, 0, 0, 0])
  end

  # A mouse event's offset is from the padding edge of the box an inline target is laid out in — past an element that
  # generates no box at all, a `display: contents` one or a `<slot>`, as the layout passes it.
  it "measures a mouse event's offset from a box, past the elements that generate none" do
    html = <<~HTML
      <!doctype html><meta charset=utf-8>
      <style>body{margin:0}div.c{margin:20px;padding:5px}</style>
      <div class=c><span id=plain>x</span></div>
      <div class=c><div style="display:contents"><span id=contents>x</span></div></div>
      <div class=c id=host><span id=slotted>x</span></div>
      <script>host.attachShadow({mode: 'open'}).innerHTML = '<slot></slot>';</script>
    HTML
    session = simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['plain', 'contents', 'slotted'].map((id) => {
        const el = document.getElementById(id), r = el.getBoundingClientRect();
        let seen = null;
        el.addEventListener('click', (e) => { seen = [e.offsetX, e.offsetY]; }, { once: true });
        el.dispatchEvent(new MouseEvent('click', { clientX: r.left + 2, clientY: r.top + 2 }));
        return seen;
      })
    JS
    expect(got.uniq.length).to eq(1)
  end
end
