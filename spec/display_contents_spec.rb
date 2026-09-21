# `display: contents` generates NO BOX: the element is replaced, for layout, by its children (CSS Display 3
# §3.1). CLAUDE.md listed it for a long time as a *rendering* subsystem this driver deliberately does not
# model, beside glyph shaping. `layout.js` says it in three places, and only three:
#
#   `layoutChildren`     enumerates the children the FLOW lays out, with every box-less one REPLACED by its
#                        own children in its place — the one list every box-level question asks
#   `inlineStyleOwner`   gives a run spliced through one that element's INHERITED style — its font, its
#                        `white-space`, its `line-height` — which the list itself cannot carry. Inherited
#                        only: a property that applies to an inline BOX is not a box-less element's to give,
#                        and `vertical-align` is read off the nearest element that has one
#   `generatesBox`       gives it no box at all, so it can neither float nor establish a context
#
# It used to say it in four SEPARATE arms — one in `isBlockLevelChild`, one in `placeInlineChild`, one in
# `contentIntrinsicWidths`, one in `separatesMargins` — each descending on its own, and every list that had
# no such arm silently laid the box-less element out as a box. The arms went when the enumeration took over;
# what they were carrying that a list cannot is `inlineStyleOwner`.
#
# The figures here are Chrome's, measured headless on this machine, and they are in the file rather than in a
# commit message on purpose: the ruling that used to exclude this was retired on a measurement, and a
# measurement nothing re-runs is exactly the "memory of a measurement" the scope list is meant to replace.
#
# Sub-pixel differences are the glyph advance, not the layout: Chrome reports 96.02 where the driver reports
# 96.00 for the same two monospace characters, and that gap is `font_resolution_fontconfig`'s, shared by every
# text shape in the suite. Hence `be_within`.
require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

RSpec.describe 'display: contents' do
  def page(body)
    Rack::Builder.new {
      run ->(_env) {
        [200, {'content-type' => 'text/html; charset=utf-8'},
         [%(<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">#{body}</body></html>)]]
      }
    }.to_app
  end

  def rect(body, selector = '#t')
    session = simulated_session(page(body))
    session.visit '/'
    r = session.evaluate_script(%(JSON.parse(JSON.stringify(document.querySelector('#{selector}').getBoundingClientRect()))))
    # …and the native WALK took the same shape, which until 2026-09-22 it did for none of these: it could not
    # place a box-less child and declined every block holding one. `compared` is asserted beside `mismatches`
    # because a record the walk DROPS looks exactly like one that agreed — a mismatch count alone would go on
    # reading 0 for a shape neither engine laid out.
    shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(shadow).to include('ok' => true, 'mismatches' => 0), body
    expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"
    r
  end

  # x, y, width, height — Chrome's, for the marked element.
  {
    'puts its inline content on the line in place' =>
      ['<div style="width:400px;font:16px monospace">x<span style="display:contents">aaaa bbbb</span><i id="t" style="display:inline-block;width:4px;height:4px"></i>y</div>',
       [96.02, 13, 4, 4]],
    'hands a block child through to the flow' =>
      ['<div style="width:400px"><span style="display:contents"><div id="t" style="height:10px">b</div></span><div style="height:5px"></div></div>',
       [0, 0, 400, 10]],
    'hands TWO block children through, stacked' =>
      ['<div style="width:400px"><span style="display:contents"><div style="height:10px">a</div><div id="t" style="height:12px">b</div></span></div>',
       [0, 10, 400, 12]],
    "makes its children the flex container's items" =>
      ['<div style="display:flex;width:400px"><span style="display:contents"><div id="t" style="width:30px;height:10px"></div><div style="width:40px;height:10px"></div></span></div>',
       [0, 0, 30, 10]],
    "makes its children the grid's items" =>
      ['<div style="display:grid;grid-template-columns:50px 60px;width:400px"><span style="display:contents"><div id="t" style="height:10px">a</div><div style="height:10px">b</div></span></div>',
       [0, 0, 50, 10]],
    # …a box-less element contributes no edges: its own padding, border and margin are dropped entirely.
    'drops its own padding' =>
      ['<div style="width:400px;font:16px monospace">x<span style="display:contents;padding:0 20px">aaaa</span><i id="t" style="display:inline-block;width:4px;height:4px"></i></div>',
       [48.02, 13, 4, 4]],
    'nests' =>
      ['<div style="width:400px;font:16px monospace">x<span style="display:contents"><span style="display:contents">aaaa</span></span><i id="t" style="display:inline-block;width:4px;height:4px"></i></div>',
       [48.02, 13, 4, 4]],
    'hands a float through to the context outside it' =>
      ['<div style="width:400px;overflow:hidden"><span style="display:contents"><div style="float:left;width:30px;height:20px"></div></span><div id="t" style="height:5px"></div></div>',
       [0, 0, 400, 5]],
    'is walked through by an intrinsic measure' =>
      ['<div style="width:max-content;font:16px monospace"><span style="display:contents">aaaa bbbb</span><i id="t" style="display:inline-block;width:4px;height:4px"></i></div>',
       [86.41, 13, 4, 4]],
    'hands a table row through to the table' =>
      ['<table style="border-spacing:0"><span style="display:contents"><tr><td style="padding:0" id="t">a</td></tr></span></table>',
       [0, 0, 7.109375, 18]]
  }.each do |name, (body, chrome)|
    it name do
      r = rect(body)
      %w[x y width height].each_with_index do |k, i|
        expect(r[k]).to be_within(0.05).of(chrome[i]), "#{k}: #{r.inspect} vs Chrome #{chrome.inspect}"
      end
    end
  end

  # …and it is the same element to the MARGIN COLLAPSING and to the native layout WALK, which is what it was
  # not until 2026-09-22. Both asked the RAW child list and got the element itself: the walk could not place a
  # box-less one and declined every block holding one (1,344 shapes of the `pseudo` sweep, the largest single
  # cause left in it), and `marginChildren` read a declaration no box carries — an empty `::before` with
  # `display: contents; height: 10px` stopped the block around it collapsing through. Both enumerate through
  # one now: `layoutChildren` is the enumeration that looks through, `flatTreeChildren` the raw one, and the
  # plain name is the looking-through one because every box-level consumer wants it.
  {
    'does not stop a margin collapsing through' =>
      ['<style>.p::before{content:"";display:contents;height:10px}</style>' \
       '<div style="width:400px"><div class="p"></div><p id="m">x</p></div>', 18, 16, 400],
    # …unless it is OUT OF FLOW, which this engine gives a box even though Chrome does not (`isBoxlessContents`
    # names the three places that do it). Not blockification — Chrome computes such an element's `display` to
    # `contents` and measures it 0x0 — but a divergence the two engines SHARE, which during the port is
    # recorded and not fixed. Pinned here because it is what the looking-through clause is carved around, and
    # a FLEX container is the one place in the repo where it is readable at all: in block flow both answers
    # coincide, and here they part in the ITEM'S WIDTH, which is why this table asserts one (below).
    'is a box again when it is positioned' =>
      ['<style>.p::before{content:"";display:contents;position:absolute;width:20px;height:10px}</style>' \
       '<div style="display:flex;width:400px"><div class="p" id="m"></div>' \
       '<div style="width:30px;height:10px"></div></div>', 10, 0, 0],
    # …and the same element to a BASELINE. A flex item's comes off the first line of the block handed
    # through it, and until 2026-09-22 the flow gave the box-less element a box for that line to be on. Once
    # there was no box, `baselineCandidates` was still enumerating the RAW children and read `child._lb.y`
    # off `undefined` — the corpus file holding this shape died in the middle and took the ten shapes after
    # it down unrun, which is how a crash arrived as a count that had quietly dropped by ten.
    'gives a baseline-aligned flex item the baseline of the block through it' =>
      ['<div style="display:flex;align-items:baseline;width:400px"><div><span style="display:contents">' \
       '<div id="m">x</div></span></div><div style="font-size:32px">BIG</div></div>', 37, 15, 8],
    # …and the WALK's half: a block-level child handed through one used to be a box it could not place.
    'hands two block children to the flow around it' =>
      ['<div style="width:400px"><span style="display:contents"><div style="height:10px">a</div>' \
       '<div id="m" style="height:12px">b</div></span></div>', 22, 10, 400]
  }.each do |name, (body, chrome_body_h, chrome_m_y, chrome_m_w)|
    it "is looked through by the flow: #{name}" do
      session = simulated_session(page(body))
      session.visit '/'
      # …the native WALK agrees about all of it, which is the half that used to decline.
      session.evaluate_script 'document.body.offsetHeight'
      shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
      expect(shadow).to include('ok' => true, 'mismatches' => 0), body
      expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"   # …as `rect` does
      # …and the figures are CHROME's: both engines were free to be wrong together while one declined and the
      # other read a box that is not there.
      # …the WIDTH as well as the position, and it is not a formality: it is the only figure that separates
      # looking through an OUT-OF-FLOW `contents` element from leaving it a box. Looked through, the
      # positioned pseudo stops being the item's content and the item takes the line's room — 200 against
      # Chrome's 0 — while the body height and the item's y come out the same either way.
      got = session.evaluate_script(<<~JS)
        (() => {
          const m = document.getElementById('m').getBoundingClientRect();
          return [document.body.getBoundingClientRect().height, m.y, m.width];
        })()
      JS
      want = [chrome_body_h, chrome_m_y, chrome_m_w]
      # …`be_within`, as the file's header says: one of these figures is the advance of an `x`, and the
      # sub-pixel gap to Chrome's is `font_resolution_fontconfig`'s, shared by every text shape in the suite.
      want.each_with_index do |w, i|
        expect(got[i]).to be_within(0.05).of(w), "#{body}: #{got.inspect}, Chrome #{want.inspect}"
      end
    end
  end

  # …and the run's STYLE is still the spliced-through element's, which is the half one enumeration nearly
  # cost. `layoutChildren` hands the flow the CHILDREN — right for every question about boxes — but a text
  # node spliced through a box-less element still draws with that element's font, collapses by its
  # `white-space` and sits on its `line-height`, and a text node has no element of its own to ask.
  # `inlineStyleOwner` is that question, asked per node in BOTH engines — and it answers for INHERITED
  # properties only, because what a box-less element can hand its content is exactly what inherits to it.
  # The one that bites is `vertical-align`: not inherited, and it applies to an inline BOX, which this
  # element is not. Chrome leaves `x<span style="display:contents;vertical-align:super">y</span>z` 18 tall
  # where the same span WITH a box is 24.33 — and a `<sup>` around one still raises its text (22.33), which
  # is the enclosing box's shift and not the spliced element's. Pinned below.
  # Every figure here was right before the flatten and wrong after it, in both engines at once: parity was
  # never broken, so no sweep could see it — only Chrome could.
  {
    'a font-size'                 => ['<div style="width:400px;font-size:10px">x<span style="display:contents;font-size:40px">aaaa</span>y</div>', 47],
    'the WRAP that font-size makes' => ['<div style="width:100px;font-size:10px"><span style="display:contents;font-size:40px">aaaa bbbb cccc</span></div>', 141],
    'a white-space'               => ['<div style="width:60px;font-size:16px">aa bb <span style="display:contents;white-space:nowrap">cccc dddd</span></div>', 36],
    'a line-height'               => ['<div style="width:400px">x<span style="display:contents;line-height:60px">y</span></div>', 60]
  }.each do |name, (body, chrome_h)|
    it "gives a run spliced through one the spliced element's own style: #{name}" do
      session = simulated_session(page(body))
      session.visit '/'
      session.evaluate_script 'document.body.offsetHeight'
      shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
      expect(shadow).to include('ok' => true, 'mismatches' => 0), body
      expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"
      h = session.evaluate_script('document.body.getBoundingClientRect().height')
      expect(h).to be_within(0.05).of(chrome_h), "#{body}: #{h}, Chrome #{chrome_h}"
    end
  end

  # …but NOT `vertical-align`, which is neither inherited nor a box-less element's to apply. Chrome, in the
  # same 16px block: 18 through a `display: contents` span, 24.328125 through one with a box, and 22.328125
  # when a `<sup>` WRAPS the box-less one — so the shift the run rides is the nearest real inline box's.
  {
    'ignores one declared on the box-less element' =>
      ['<div style="width:400px;font-size:16px">x<span style="display:contents;vertical-align:super">y</span>z</div>', 18],
    'keeps the one an enclosing inline box declares' =>
      ['<div style="width:400px;font-size:16px">x<sup><span style="display:contents">y</span></sup>z</div>', 22.328125],
    'is the control: the same span WITH a box' =>
      ['<div style="width:400px;font-size:16px">x<span style="vertical-align:super">y</span>z</div>', 24.328125]
  }.each do |name, (body, chrome_h)|
    it "reads vertical-align off the nearest element that HAS a box: #{name}" do
      session = simulated_session(page(body))
      session.visit '/'
      session.evaluate_script 'document.body.offsetHeight'
      shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
      expect(shadow).to include('ok' => true, 'mismatches' => 0), body
      expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"
      h = session.evaluate_script('document.body.getBoundingClientRect().height')
      expect(h).to be_within(0.05).of(chrome_h), "#{body}: #{h}, Chrome #{chrome_h}"
    end
  end

  # …and a whitespace-only group between two block children is dropped without an attempt, which is right
  # until the space is a LINE. The mixed-block path asked that in its own words — `COLLAPSING_WS.has(wsMode)`
  # about the BLOCK — where the other four places ask `whiteSpaceOnlyIsContent` about the element the node is
  # written in, so no grep for the shared helper found it. A `pre-wrap` space spliced through a box-less
  # element made a line the oracle drew and the walk threw away: Chrome and the oracle put `#m` at 46, the
  # walk at 36, three mismatches.
  it 'keeps an anonymous group whose only space is a line in the spliced element' do
    body = '<div style="width:400px">t<div style="height:10px"></div>' \
           '<span style="display:contents;white-space:pre-wrap"> </span><div id="m" style="height:10px"></div></div>'
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(shadow).to include('ok' => true, 'mismatches' => 0), body
    expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"
    expect(session.evaluate_script("document.getElementById('m').getBoundingClientRect().y")).to eq(46)
  end

  # …and a `<slot>` is one of these on every shadow-DOM page: the UA sheet gives it `display: contents`
  # (`style-proxy.js`), so text assigned to a styled slot is a run spliced through one. Chrome: 50.
  it "gives a slot's assigned text the slot's own line-height" do
    session = simulated_session(page(<<~HTML))
      <div style="width:400px"><my-el>aaaa</my-el></div>
      <script>
        customElements.define('my-el', class extends HTMLElement {
          connectedCallback() {
            const r = this.attachShadow({mode: 'open'});
            r.innerHTML = '<style>slot{font-size:40px;line-height:50px}</style><slot></slot>';
          }
        });
      </script>
    HTML
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(shadow).to include('ok' => true, 'mismatches' => 0)
    expect(shadow['compared']).to be > 0, "nothing compared: #{shadow.inspect}"
    # …a whole-pixel answer, so `eq`: nothing here is a glyph advance.
    expect(session.evaluate_script('document.body.getBoundingClientRect().height')).to eq(50)
  end

  # …and CLEARANCE is asked about the box's PLACE among its siblings, which a box-less ancestor is not one of.
  # `precedingFloat` climbs to the nearest ancestor that HAS a box, because that is the list the box itself is
  # in; climbing to the box-less element left its identity test matching nothing, and the scan ran on past
  # every LATER sibling — reporting a float written after this box as one it must clear, so the box kept its
  # own top margin instead of collapsing it out. Chrome puts it at 30; both engines said 0.
  it 'does not clear a float written after a box spliced through one' do
    body = '<div style="width:400px"><span style="display:contents">' \
           '<div id="m" style="clear:left;margin-top:30px">x</div></span>' \
           '<div style="float:left;width:10px;height:5px"></div></div>'
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(shadow).to include('ok' => true, 'mismatches' => 0), body
    expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"
    expect(session.evaluate_script("document.getElementById('m').getBoundingClientRect().y")).to eq(30)
  end

  # …and the SCROLLABLE OVERFLOW through one, which is the site that would have failed silently. The extent
  # walk reads each child's `_lbExt` and skips a child that has none (`if (!ce) continue`) — so the moment the
  # flow stopped giving a box-less element a box, an overflowing subtree behind one simply stopped counting
  # toward its scroller. No mismatch, no decline, no crash: the scroller would have reported itself unscrollable.
  it 'counts an overflowing subtree behind one toward its scroller' do
    session = simulated_session(page(
      '<div id="s" style="width:100px;height:50px;overflow:auto">' \
      '<span style="display:contents"><div style="height:300px;width:220px"></div></span></div>'
    ))
    session.visit '/'
    session.evaluate_script 'document.body.offsetHeight'
    shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
    expect(shadow).to include('ok' => true, 'mismatches' => 0)
    expect(shadow['compared']).to be > 0, "nothing compared: #{shadow.inspect}"
    got = session.evaluate_script("(s => [s.scrollHeight, s.scrollWidth])(document.getElementById('s'))")
    expect(got).to eq([300, 220]), "#{got.inspect}, Chrome [300, 220]"
  end

  # …and the place it USED to be wrong, which the same flatten closed. A box-less element resolved a used
  # width of its own here and a percentage-sized pseudo resolved against that instead of against the parent's
  # content box — 40px where Chrome says 50, and likewise through `padding`, through a `margin` that is no
  # box's edge at all, and 30 where a declared `width` replaced the basis outright. A phantom box, and it was
  # the one the OTHER engine's block flow kept: once `layoutChildren` is what lays the children out,
  # there is no box for the percentage to find. `css/cssom/getComputedStyle-pseudo.html` came off the WPT
  # allowlist with it.
  # Every arm is Chrome's 50px: the basis is `#box`'s content box, whatever `#c` declares.
  ['border: 10px solid red', 'padding: 0 10px', 'margin: 0 10px', 'border: 10px solid red; width:60px',
   'width: 60px', ''].each do |decl|
    it "resolves a percentage pseudo against the PARENT's content box (#{decl.empty? ? 'nothing declared' : decl})" do
      body = <<~HTML
        <style>
          #box { width: 100px }
          #c { display: contents; #{decl} }
          #c::before { content: "x"; width: 50%; display: block }
        </style>
        <div id="box"><div id="c">c</div></div>
      HTML
      session = simulated_session(page(body))
      session.visit '/'
      expect(session.evaluate_script(%(getComputedStyle(document.getElementById('c'), '::before').width))).to eq('50px')
      # …and the WALK takes the shape too, so "the walk takes all of these" is asserted of all of them and
      # not of the ten that happen to read a rect.
      shadow = session.evaluate_script('globalThis.__csimLayoutShadowRun()')
      expect(shadow).to include('ok' => true, 'mismatches' => 0), body
      expect(shadow['compared']).to be > 0, "#{body}: nothing compared: #{shadow.inspect}"
    end
  end
end
