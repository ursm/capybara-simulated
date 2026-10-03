# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# CSSOM View's offsets (geometry.rs `offsets`): the offsetParent is found up the FLAT tree, skipping what a closed
# shadow tree hides, and is the containing block of absolutely positioned boxes — a transform or a filter makes one as
# much as a `position` does — and a fixed box's is only the ancestor that contains it. Every figure is Chrome's.
RSpec.describe 'offsets' do
  def offsets(body, script)
    html = %(<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:8px;font:16px Arial">#{body}</body></html>)
    session = simulated_session(->(_env) { [200, {'content-type' => 'text/html; charset=utf-8'}, [html]] })
    session.visit '/'
    session.evaluate_script(<<~JS)
      (() => {
        const show = (e) => [e.offsetParent && (e.offsetParent.id || e.offsetParent.tagName), e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight];
        #{script}
      })()
    JS
  end

  it 'finds a positioned shadow host, and a positioned box in a closed tree for its slotted content' do
    got = offsets(
      '<div id="phost" style="position:relative;margin:10px;padding:4px"></div>' \
      '<div id="chost" style="position:relative;margin:10px"><span id="slotted" style="display:inline-block;width:5px;height:5px"></span></div>',
      <<~JS
        const sr = document.getElementById('phost').attachShadow({mode: 'open'});
        sr.innerHTML = '<div id="inner" style="margin:1px 1px">x</div>';
        document.getElementById('chost').attachShadow({mode: 'closed'}).innerHTML = '<div style="position:relative;padding:6px"><slot></slot></div>';
        return [show(sr.getElementById('inner')), show(document.getElementById('slotted'))];
      JS
    )
    expect(got).to eq([['phost', 5, 5, 978, 18], ['chost', 6, 15, 5, 5]])
  end

  it 'measures from the transformed or filtered ancestor that contains a box, past a positioned one for a fixed box' do
    got = offsets(
      '<div id="r6" style="transform:translateX(10px);padding:5px"><div id="fx" style="position:fixed;left:2px;top:0;width:5px;height:5px"></div>' \
      '<div id="ab" style="position:absolute;width:5px;height:5px"></div></div>' \
      '<div id="r7" style="filter:blur(0);padding:5px"><div style="position:relative;margin-left:3px"><div id="fx2" style="position:fixed;width:5px;height:5px"></div></div></div>',
      "return ['fx', 'ab', 'fx2'].map((id) => show(document.getElementById(id)));"
    )
    expect(got).to eq([['r6', 2, 0, 5, 5], ['r6', 5, 5, 5, 5], ['r7', 8, 5, 5, 5]])
  end

  # The body's own offsets are 0, whatever its margin puts it at ("the HTML body element").
  it 'puts the body at 0' do
    expect(offsets('<p>x</p>', 'return show(document.body).slice(0, 3);')).to eq([nil, 0, 0])
  end
end
