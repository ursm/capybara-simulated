# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# WHERE a line may break, beyond the collapsible space between two words (CSS Text 3 §5, UAX #14
# as Chrome applies it). Four rules the flow lacked, Chrome-measured at 16px monospace (19 cases,
# all matched):
#   - no break follows a run placed WHOLE — a `nowrap` / `pre` run, its trailing space included:
#     the opportunity after a space belongs to the space's own `white-space`, so the next word
#     stays on the line and overflows, and the line breaks at the next collapsible space of a
#     wrapping context (which still counts when it collapses against the run's own space)
#   - a hyphen between two letters or digits is a break opportunity after it, like a space
#   - a soft hyphen (U+00AD) is one too, and shows a hyphen only where the line breaks at it
#   - a `display: contents` box is no box: its inline content sits on the line in place
#
# Every figure is a formula over runs measured on the same page.
RSpec.describe 'line breaking' do
  def page(body, css = '')
    session = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html; charset=utf-8'}, [<<~HTML]]
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { margin: 0; font: 16px monospace }
          #{css}
        </style></head><body>#{body}<span id="__w" style="white-space:pre"></span></body></html>
      HTML
    })
    session.visit '/'
    session
  end

  # The rects of every `[id]` and a measurer for runs in the page's font.
  def lay(body, css = '')
    s = page(body, css)
    r = s.evaluate_script(<<~JS)
      (function () {
        var out = {};
        document.querySelectorAll('[id]').forEach(function (el) { var q = el.getBoundingClientRect(); out[el.id] = [q.x, q.y, q.width, q.height]; });
        return out;
      })()
    JS
    w = ->(text) { s.evaluate_script("(function () { var p = document.getElementById('__w'); p.textContent = #{text.to_json}; return p.getBoundingClientRect().width; })()") }
    [r, w]
  end

  # A block just wide enough for `text` plus a little.
  def fits(text)
    (lay("<span id=t>#{text}</span>")[0]['t'][2] + 1).ceil
  end

  # ── after a run placed whole ──
  it 'does not break between a nowrap run\'s trailing space and the next word' do
    fits = fits('aaaa bbbb cccc')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span style=\"white-space:nowrap\">aaaa bbbb </span><span id=g>cccc</span> <span id=h>dddd</span></div>")
    expect(r['g'][0]).to be_within(0.01).of(w.call('aaaa bbbb '))   # on the first line, past the edge or not
    expect(r['g'][1]).to eq(r['b'][1])
    expect(r['h'][1]).to be > r['b'][1]                             # the break came at the block's space
  end

  it 'does not break after a pre run either' do
    fits = fits('aaaa bbbb cccc')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span style=\"white-space:pre\">aaaa bbbb </span><span id=g>cccc</span> <span id=h>dddd</span></div>")
    expect(r['g'][0]).to be_within(0.01).of(w.call('aaaa bbbb '))
    expect(r['g'][1]).to eq(r['b'][1])
    expect(r['h'][1]).to be > r['b'][1]
  end

  it 'breaks at the wrapping space that collapses against the run\'s own' do
    fits = fits('aaaa bbbb')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span style=\"white-space:nowrap\">aaaa bbbb </span> <span id=g>cccc</span></div>")
    expect(r['g'][0]).to eq(0)
    expect(r['g'][1]).to be > r['b'][1]
  end

  # ── hyphens ──
  it 'breaks after a hyphen between letters' do
    fits = fits('aaaa-bbbb-cccc-')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span id=t>aaaa-bbbb-cccc-dddd</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaa-bbbb-cccc-'))   # the first line's piece
    expect(r['b'][3]).to be_within(0.01).of(2 * lay('<div id=t>a</div>')[0]['t'][3])
  end

  it 'breaks after a hyphen between digits' do
    fits = fits('12-34-56-')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span id=t>12-34-56-78-90</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('12-34-56-'))
  end

  it 'keeps a hyphenated word together where it fits' do
    r, w = lay('<div style="width:300px"><span id=t>aaaa-bb</span></div>')
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaa-bb'))
    expect(r['t'][3]).to be_within(0.01).of(lay('<div id=t>a</div>')[0]['t'][3])
  end

  it 'does not break at a slash' do
    fits = fits('aaaa/bbbb')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span id=t>aaaa/bbbb/cccc</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaa/bbbb/cccc'))
    expect(r['t'][3]).to be_within(0.01).of(lay('<div id=t>a</div>')[0]['t'][3])
  end

  # ── soft hyphens ──
  it 'breaks at a soft hyphen and shows a hyphen there' do
    fits = fits('aaaabbbb-')
    r, w = lay("<div id=b style=\"width:#{fits}px\"><span id=t>aaaabbbb&shy;ccccdddd</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaabbbb-'))            # the hyphen is on the line
    expect(r['b'][3]).to be_within(0.01).of(2 * lay('<div id=t>a</div>')[0]['t'][3])
  end

  it 'hides a soft hyphen where the word does not break' do
    r, w = lay('<div style="width:300px"><span id=t>aaaa&shy;bbbb</span></div>')
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaabbbb'))
  end

  it 'counts the shown hyphen in a min-content width' do
    r, w = lay('<div id=t style="width:min-content">aaaa&shy;bbbbbb</div>')
    expect(r['t'][2]).to be_within(0.01).of(w.call('bbbbbb'))              # the widest piece, hyphen included where shown
    r2, w2 = lay('<div id=t style="width:min-content">aaaaaaa&shy;bb</div>')
    expect(r2['t'][2]).to be_within(0.01).of(w2.call('aaaaaaa-'))
  end

  # ── display: contents ──
  it 'keeps a display: contents box\'s inline content on the line' do
    r, w = lay('<div style="width:300px"><span id=x>x</span><span style="display:contents"><span id=m>aaaa bbbb</span></span><span id=y>y</span></div>')
    expect(r['m'][0]).to be_within(0.01).of(w.call('x'))
    expect(r['y'][0]).to be_within(0.01).of(w.call('xaaaa bbbb'))
    expect(r['y'][1]).to eq(r['x'][1])
  end

  it 'still lays a display: contents box holding a block out as blocks' do
    r, = lay('<div style="width:300px"><span id=x>x</span><span style="display:contents"><div id=m>block</div></span><span id=y>y</span></div>')
    expect(r['m'][1]).to be > r['x'][1]
    expect(r['y'][1]).to be > r['m'][1]
  end
end
