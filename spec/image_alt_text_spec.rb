# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An `<img>` that does not represent an image (HTML §15.4.4 "Images"): a non-replaced phrasing element whose content is
# its alt text — its dimension attributes and its `width` ignored as an inline's are — unless both its dimensions are
# given and its image is coming, or it has no `alt`, or its document is in quirks mode: then a replaced element of those
# dimensions. `alt=""`, or no `alt` and no `src`, with not both dimensions: nothing (0x0). Chrome and Firefox agree on
# each shape here but for the icon Chrome draws beside the text, which the steps leave optional and Firefox does not
# draw (Chrome: `alt="hello world"` 89x18 = its text's 73.3 and a 16px icon; Firefox 87x22 in its own font).
# [id, width, height, its box's width rounded] — Chrome's block one 780x18 at its 780px viewport.
RSpec.describe 'an image rendering its alt text' do
  def measured(body, doctype: true)
    page = "#{'<!doctype html>' if doctype}<meta charset=\"utf-8\"><body style=\"margin:0\">#{body}"
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      [...document.images].map((i) => [i.id, i.width, i.height, Math.round(i.getBoundingClientRect().width)])
    JS
  end

  it 'lays a broken image with alt text out as a run of it, and one with none as nothing' do
    got = measured(<<~HTML)
      <div><img id=text alt="hello world"></div>
      <div><img id=sized alt="hello" width=100 height=50 style="width:30px"></div>
      <div><img id=broken src="data:," alt="hello" width=100 height=50></div>
      <div><img id=empty src="data:," alt=""></div>
      <div><img id=bare></div>
      <div><img id=padded alt="hello" style="padding:3px; border:1px solid"></div>
    HTML
    expect(got).to eq([
      ['text', 73, 17, 73], ['sized', 32, 17, 32], ['broken', 32, 17, 32], ['empty', 0, 0, 0], ['bare', 0, 0, 0],
      ['padded', 32, 17, 40]
    ])
  end

  it 'keeps one replaced with both dimensions and no alt text, an empty one, or in quirks mode' do
    got = measured(<<~HTML)
      <div><img id=noalt src="data:," width=100 height=50></div>
      <div><img id=emptyalt src="data:," alt="" width=100 height=50></div>
      <div><img id=css src="data:," style="width:60px; height:20px"></div>
    HTML
    expect(got).to eq([['noalt', 100, 50, 100], ['emptyalt', 100, 50, 100], ['css', 60, 20, 60]])
    expect(measured('<img id=q src="data:," alt="hello" width=100 height=50>', doctype: false)).to eq([['q', 100, 50, 100]])
  end

  it 'is a block of its text where it is displayed as one, and follows its alt text' do
    expect(measured('<img id=b alt="hello" style="display:block">')).to eq([['b', 1024, 18, 1024]])
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><body><img id=i src="data:," alt="hello world">']] })
    session.visit '/'
    widths = ['x', nil].map {|alt|
      session.execute_script(alt ? "document.getElementById('i').alt = '#{alt}'" : "document.getElementById('i').removeAttribute('alt')")
      session.evaluate_script("Math.round(document.getElementById('i').getBoundingClientRect().width)")
    }
    expect(widths).to eq([8, 16])
  end

  # (…a non-replaced element, which its `::before` and `::after` render in — Chrome both, Firefox the `::after`; and
  # one whose `display: contents` is `none`, as an image's is: CSS Display 3 Appendix B, Chrome and Firefox 0 tall)
  it 'renders its pseudo-elements beside its alt text, and nothing for display: contents' do
    page = <<~HTML
      <!doctype html><meta charset="utf-8"><style>#a::before { content: "BEFORE " } #a::after { content: " AFTER" }</style>
      <body style="margin:0"><div><img id=a alt="hello world"></div><div><span id=s>BEFORE hello world AFTER</span></div>
      <div id=c><img alt="hello world" style="display:contents"></div>
    HTML
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['a', 's', 'c'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.width, r.height]; })
    JS
    expect(got[0]).to eq(got[1])
    expect(got[2][1]).to eq(0)
  end
end
