require 'capybara/simulated'
require_relative 'support/session_teardown'

# SVG geometry (svg_geometry.rs): an SVG element's client rect through its viewports (`viewBox`, a nested `<svg>`) and
# `transform`s — a path's to its curves' extremes, a container's its children's union, a shape inside a shape none —
# and the hit test finding the graphics element under a point inside an `<svg>`, so a click on an icon reaches its
# shape. Every figure Chrome's (2026-10-10).
RSpec.describe 'SVG geometry' do
  let(:html) {
    <<~HTML
      <!doctype html><meta charset=utf-8><style>body{margin:0}</style>
      <svg id=sv width=100 height=100 viewBox="0 0 50 50" style="border:2px solid;padding:3px"><rect id=r x=5 y=5 width=20 height="10"/><circle id=c cx=30 cy=30 r="5"/><g id=g transform="translate(10,0)"><path id=pa d="M0 40 L10 40 L10 48 Z"/><path id=cu d="M20 40 C20 50 30 50 30 40"/></g><ellipse id=e cx=40 cy=10 rx=8 ry=3 transform="rotate(45 40 10)"/><svg id=in x=30 y=30 width=20 height=20 viewBox="0 0 10 10"><rect id=ir x=0 y=0 width=5 height="5"/></svg><polygon id=pg points="0,45 5,50 0,50"/></svg>
      <svg id=icon width=40 height=40><rect id=hit width=40 height=40 onclick="window.clicked = this.id"><path d="M0 0 L5 5"/></rect></svg>
    HTML
  }
  let(:session) { simulated_session(->(_) { [200, {'content-type' => 'text/html'}, [html]] }) }

  it 'measures an SVG element through its viewports and transforms' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      ['r', 'c', 'g', 'pa', 'cu', 'e', 'in', 'ir', 'pg'].map((i) => {
        const b = document.getElementById(i).getBoundingClientRect();
        return [i, ...[b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100)];
      })
    JS
    expect(got).to eq([
      ['r', 15, 15, 40, 20], ['c', 55, 55, 20, 20], ['g', 25, 85, 60, 16], ['pa', 25, 85, 20, 16],
      ['cu', 65, 85, 20, 15], ['e', 69.44, 9.44, 31.11, 31.11], ['in', 65, 65, 20, 20], ['ir', 65, 65, 20, 20],
      ['pg', 5, 95, 10, 10]
    ])
  end

  it 'hits the graphics element under a point, and a click on an icon reaches it' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      [[20, 20], [65, 65], [45, 90], [5, 5], [80, 25], [72, 72], [3, 95]].map(([x, y]) => document.elementFromPoint(x, y)?.id)
    JS
    expect(got).to eq(%w[r ir pa sv e ir sv])
    session.find('#icon').click
    expect(session.evaluate_script('window.clicked')).to eq('hit')
  end
end
