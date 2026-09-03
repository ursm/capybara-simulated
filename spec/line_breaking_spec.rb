# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# WHERE a line may break, beyond the collapsible space between two words (CSS Text 3 §5, UAX #14
# as Chrome applies it). The rules the flow lacked, Chrome-measured at 16px monospace (19 + 46 +
# 44 + 24 cases over two review rounds, every geometry matched):
#   - a break opportunity belongs to the character BEFORE it: after a `nowrap` / `pre` context's
#     space nothing may start a line — the next word stays and overflows, an atomic inline too —
#     and the line breaks at the next opportunity of a wrapping context (which still counts when
#     its space collapses against the run's own); after a letter the next TEXT continues the word,
#     across inline boxes (`foo<b>barbaz</b>` is one word), but an atomic inline may start a line
#   - a hyphen, en dash or figure dash between letters or digits is an opportunity after it, an em
#     dash on both sides, a non-breaking hyphen (U+2011) none; `-5` and `foo-,bar` hold, `--no`
#     breaks after each hyphen
#   - a soft hyphen (U+00AD) is one too, and shows a hyphen — its own fragment — only where the
#     line breaks at it: the LAST soft hyphen whose piece fits with its hyphen, or the piece that
#     overflows even alone; `hyphens: none` takes them out
#   - `overflow-wrap` / `word-wrap` / `word-break` INHERIT, and a hyphenated word's pieces each
#     start a fresh line under `overflow-wrap: break-word` (not under `word-break: break-all`)
#   - a `display: contents` box is no box: its inline content sits on the line in place
#   - a `<slot>` inherits its font from the host chain, so slotted bare text measures in it
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

  # The rects of every `[id]`, a measurer for runs in the page's font, and the session.
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
    [r, w, s]
  end

  # A block just wide enough for `text` plus a little.
  def fits(text)
    (lay("<span id=t>#{text}</span>")[0]['t'][2] + 1).ceil
  end

  # The height of one line of the page's font.
  def line_height
    lay('<div id=t>a</div>')[0]['t'][3]
  end

  # ── after a run placed whole ──
  it 'does not break between a nowrap run\'s trailing space and the next word' do
    width = fits('aaaa bbbb cccc')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span style=\"white-space:nowrap\">aaaa bbbb </span><span id=g>cccc</span> <span id=h>dddd</span></div>")
    expect(r['g'][0]).to be_within(0.01).of(w.call('aaaa bbbb '))   # on the first line, past the edge or not
    expect(r['g'][1]).to eq(r['b'][1])
    expect(r['h'][1]).to be > r['b'][1]                             # the break came at the block's space
  end

  it 'does not break after a pre run either' do
    width = fits('aaaa bbbb cccc')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span style=\"white-space:pre\">aaaa bbbb </span><span id=g>cccc</span> <span id=h>dddd</span></div>")
    expect(r['g'][0]).to be_within(0.01).of(w.call('aaaa bbbb '))
    expect(r['g'][1]).to eq(r['b'][1])
    expect(r['h'][1]).to be > r['b'][1]
  end

  it 'breaks at the wrapping space that collapses against the run\'s own' do
    width = fits('aaaa bbbb')
    r, = lay("<div id=b style=\"width:#{width}px\"><span style=\"white-space:nowrap\">aaaa bbbb </span> <span id=g>cccc</span></div>")
    expect(r['g'][0]).to eq(0)
    expect(r['g'][1]).to be > r['b'][1]
  end

  it 'lets an atomic inline start a line after nowrap letters, not after a nowrap space' do
    width = fits('aaaa bbbb cccc')
    r, = lay("<div id=b style=\"width:#{width}px\"><span style=\"white-space:nowrap\">aaaa bbbb cccc</span><span id=g style=\"display:inline-block\">dddd</span></div>")
    expect(r['g'][0]).to eq(0)
    expect(r['g'][1]).to be > r['b'][1]
    r, w = lay("<div id=b style=\"width:#{width}px\"><span style=\"white-space:nowrap\">aaaa bbbb cccc </span><span id=g style=\"display:inline-block\">dddd</span></div>")
    expect(r['g'][0]).to be_within(0.01).of(w.call('aaaa bbbb cccc '))
    expect(r['g'][1]).to eq(r['b'][1])
  end

  it 'keeps the words around a nowrap white-space node together' do
    width = fits('aaaa')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span id=a>aaaa</span><span style=\"white-space:nowrap\"> </span><span id=g>bbbb</span></div>")
    expect(r['g'][0]).to be_within(0.01).of(w.call('aaaa '))
    expect(r['g'][1]).to eq(r['a'][1])
  end

  # ── an inline box boundary is no opportunity ──
  it 'does not break inside the word an inline box cuts' do
    width = fits('foo')
    r, w = lay("<div style=\"width:#{width}px\"><span id=t>foo<b id=k>barbaz</b></span></div>")
    expect(r['k'][0]).to be_within(0.01).of(w.call('foo'))
    expect(r['k'][1]).to eq(r['t'][1])
    expect(r['t'][3]).to be_within(0.01).of(line_height)
  end

  it 'still breaks after a hyphen an inline box opens with' do
    width = fits('foo-')
    r, = lay("<div style=\"width:#{width}px\"><span id=t>foo<b>-<span id=k>bar</span></b></span></div>")
    expect(r['k'][0]).to eq(0)
    expect(r['k'][1]).to be > r['t'][1]
  end

  # ── hyphens and dashes ──
  it 'breaks after a hyphen between letters' do
    width = fits('aaaa-bbbb-cccc-')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span id=t>aaaa-bbbb-cccc-dddd</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaa-bbbb-cccc-'))   # the first line's piece
    expect(r['b'][3]).to be_within(0.01).of(2 * line_height)
  end

  it 'breaks after a hyphen between digits' do
    width = fits('12-34-56-')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span id=t>12-34-56-78-90</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('12-34-56-'))
  end

  it 'keeps a hyphenated word together where it fits' do
    r, w = lay('<div style="width:300px"><span id=t>aaaa-bb</span></div>')
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaa-bb'))
    expect(r['t'][3]).to be_within(0.01).of(line_height)
  end

  it 'does not break at a slash' do
    width = fits('aaaa/bbbb')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span id=t>aaaa/bbbb/cccc</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaa/bbbb/cccc'))
    expect(r['t'][3]).to be_within(0.01).of(line_height)
  end

  it 'breaks after an en dash, on both sides of an em dash, and never at a non-breaking hyphen' do
    width = fits('foo')
    lines = ->(word) { lay("<div style=\"width:#{width}px\"><span id=t>#{word}</span></div>")[0]['t'][3] / line_height }
    expect(lines.call("foo–bar")).to be_within(0.01).of(2)     # "foo–" / "bar"
    expect(lines.call("foo—bar")).to be_within(0.01).of(3)     # "foo" / "—" / "bar"
    expect(lines.call("foo‑bar")).to be_within(0.01).of(1)
  end

  it 'does not break before the digit a hyphen signs' do
    width = fits('xx')
    lines = ->(text) { lay("<div style=\"width:#{width}px\"><span id=t>#{text}</span></div>")[0]['t'][3] / line_height }
    expect(lines.call('xx -55')).to be_within(0.01).of(2)             # "xx" / "-55"
    expect(lines.call('xx -aa')).to be_within(0.01).of(3)             # "xx" / "-" / "aa"
  end

  it 'breaks after each hyphen of a double one' do
    width = fits('xxxx -')
    r, w, s = lay("<div style=\"width:#{width}px\"><span id=t>xxxx --no-cache</span></div>")
    expect(r['t'][3]).to be_within(0.01).of(3 * line_height)          # "xxxx -" / "-no-" / "cache"
    last = s.evaluate_script("(function () { var rs = document.getElementById('t').getClientRects(); return rs[rs.length - 1].width; })()")
    expect(last).to be_within(0.01).of(w.call('cache'))
  end

  # ── soft hyphens ──
  it 'breaks at a soft hyphen and shows a hyphen there' do
    width = fits('aaaabbbb-')
    r, w = lay("<div id=b style=\"width:#{width}px\"><span id=t>aaaabbbb&shy;ccccdddd</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaabbbb-'))            # the hyphen is on the line
    expect(r['b'][3]).to be_within(0.01).of(2 * line_height)
  end

  it 'hides a soft hyphen where the word does not break' do
    r, w = lay('<div style="width:300px"><span id=t>aaaa&shy;bbbb</span></div>')
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaabbbb'))
  end

  it 'breaks at the last soft hyphen whose piece fits with its hyphen' do
    width = fits('aabb')                                                    # "bb-" does not fit after "aa"
    r, w, s = lay("<div style=\"width:#{width}px;text-align:right\"><span id=t>aa&shy;bb&shy;cc</span></div>")
    first = s.evaluate_script("document.getElementById('t').getClientRects()[0].x")
    expect(first).to be_within(0.01).of(width - w.call('aa-'))               # "aa-" right-aligned on line 1
    expect(r['t'][3]).to be_within(0.01).of(2 * line_height)                # then "bbcc"
  end

  it 'shows the hyphen of a piece that overflows on its own' do
    width = fits('aaaa')
    r, w = lay("<div style=\"width:#{width}px\"><span id=t>aaaabbb&shy;cc</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaabbb-'))              # the first line, past the edge
    expect(r['t'][3]).to be_within(0.01).of(2 * line_height)
  end

  it 'shows the hyphen when the next inline box\'s text breaks after it' do
    width = fits('aaaa-')
    r, w, s = lay("<div style=\"width:#{width}px;text-align:right\"><span id=t>aaaa&shy;<b id=k>bbbb</b></span></div>")
    expect(r['k'][1]).to be > r['t'][1]
    first = s.evaluate_script("document.getElementById('t').getClientRects()[0].x")
    expect(first).to be_within(0.01).of(width - w.call('aaaa-'))
  end

  it 'takes the soft hyphens out under hyphens: none' do
    width = fits('aaaa-')
    r, w = lay("<div style=\"width:#{width}px;hyphens:none\"><span id=t>aaaa&shy;bbbb</span></div>")
    expect(r['t'][2]).to be_within(0.01).of(w.call('aaaabbbb'))
    expect(r['t'][3]).to be_within(0.01).of(line_height)
  end

  it 'counts the shown hyphen in a min-content width' do
    r, w = lay('<div id=t style="width:min-content">aaaa&shy;bbbbbb</div>')
    expect(r['t'][2]).to be_within(0.01).of(w.call('bbbbbb'))              # the widest piece, hyphen included where shown
    r2, w2 = lay('<div id=t style="width:min-content">aaaaaaa&shy;bb</div>')
    expect(r2['t'][2]).to be_within(0.01).of(w2.call('aaaaaaa-'))
  end

  # ── breaking inside a word ──
  it 'inherits overflow-wrap and word-break from an ancestor' do
    width = fits('bbbbbb')
    r, = lay("<div style=\"width:#{width}px;word-wrap:break-word\"><p id=t style=\"margin:0\"><a href=\"#\">bbbbbbbbbbbb</a></p></div>")
    expect(r['t'][3]).to be_within(0.01).of(2 * line_height)
    r, = lay("<div style=\"width:#{width}px;word-break:break-all\"><p id=t style=\"margin:0\">bbbbbbbbbbbb</p></div>")
    expect(r['t'][3]).to be_within(0.01).of(2 * line_height)
  end

  it 'starts each piece of a hyphenated word fresh under overflow-wrap: break-word' do
    width = fits('aaaaaaaaaa')
    r, = lay("<div style=\"width:#{width}px;overflow-wrap:break-word\"><span id=t>aaaaaaaaaaaa-bbbbbbbbbbbbbb</span></div>")
    expect(r['t'][3]).to be_within(0.01).of(4 * line_height)                # "aaaaaaaaaa" / "aa-" / "bbbbbbbbbb" / "bbbb"
    r, = lay("<div style=\"width:#{width}px;word-break:break-all\"><span id=t>aaaaaaaaaaaa-bbbbbbbbbbbbbb</span></div>")
    expect(r['t'][3]).to be_within(0.01).of(3 * line_height)                # …where `break-all` fills every line
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

  # ── slotted text ──
  it 'measures slotted bare text in the font the slot inherits from its host' do
    _, w, s = lay('<div style="width:300px"><span id=h style="font-size:32px">aaaa</span></div>')
    s.execute_script("document.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'")
    expect(s.evaluate_script("document.getElementById('h').getBoundingClientRect().width")).to be_within(0.01).of(2 * w.call('aaaa'))
    slot = s.evaluate_script("(function () { var c = getComputedStyle(document.getElementById('h').shadowRoot.firstChild); return [c.fontFamily, c.fontSize]; })()")
    expect(slot).to eq(['monospace', '32px'])
  end
end
