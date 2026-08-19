# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# getComputedStyle resolution for layout-free values commonly read by app JS: the inherited
# font longhands (`font-size` / `font-weight` / `font-style` / `line-height` / `font-family`,
# which the canvas em/rem/lh path also depends on), the `visibility` / `opacity` / `text-align`
# / `cursor` / `pointer-events` values and the `display` (flex/grid/inline-block) + flexbox
# longhands (which a stylesheet rule must reflect, not just inline), and the `parentRule` of a
# computed declaration.
RSpec.describe 'getComputedStyle resolved values' do
  # Serve a full HTML document and return a visited session.
  def build_session(html)
    app = Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] }
    }.to_app
    Capybara.app = app
    session = simulated_session(app)
    session.visit '/'
    session
  end

  # The font-size battery shares one <style> block; callers supply just the body.
  def session_for(body_html)
    build_session(<<~HTML)
      <!DOCTYPE html><html><head><style>
        html { font-size: 20px; }
        #px    { font-size: 100px; }
        #em    { font-size: 2em; }
        #pct   { font-size: 150%; }
        #rem   { font-size: 1.5rem; }
        #kw    { font-size: large; }
        #outer { font-size: 40px; }
      </style></head><body>#{body_html}</body></html>
    HTML
  end

  it 'resolves font-size across px, em, %, rem, keyword, and inheritance' do
    session = session_for('<div id="px"></div><div id="em"></div><div id="pct"></div>' \
                          '<div id="rem"></div><div id="kw"></div>' \
                          '<div id="outer"><div id="child">c</div></div>')
    out = session.evaluate_script(<<~JS)
      const fs = (id) => getComputedStyle(document.getElementById(id)).fontSize;
      JSON.stringify({
        root:  getComputedStyle(document.documentElement).fontSize,
        body:  getComputedStyle(document.body).fontSize,
        px:    fs('px'),
        em:    fs('em'),
        pct:   fs('pct'),
        rem:   fs('rem'),
        kw:    fs('kw'),
        child: fs('child'),
      });
    JS
    r = JSON.parse(out)
    expect(r['root']).to eq('20px')    # html
    expect(r['body']).to eq('20px')    # inherits from html
    expect(r['px']).to eq('100px')     # absolute length
    expect(r['em']).to eq('40px')      # 2 * parent 20
    expect(r['pct']).to eq('30px')     # 1.5 * parent 20
    expect(r['rem']).to eq('30px')     # 1.5 * root 20
    expect(r['kw']).to eq('18px')      # `large` (browsers use a fixed keyword table)
    expect(r['child']).to eq('40px')   # inherits #outer
  end

  # …and across the units that need something other than the parent's size: the VIEWPORT
  # (`font-size: 5vw` is how a responsive page scales its type — it used to inherit instead,
  # since the resolver's unit table stopped at the absolute units) and the FONT FILE (`ex` /
  # `ch` measure the PARENT's font, because this element's is what they are computing; they
  # answered a flat 0.5em, which is only the spec's fallback for a font we can't read).
  #
  # The font-derived pair is asserted as a RELATION to the same metrics elsewhere in the page
  # rather than as pixels, so it holds whichever face fontconfig serves. Chrome 151 here
  # (16px Arial → Liberation Sans): 2ex = 16.906px, 3ch = 26.695px, 5vw = 51.2px at 1024.
  it 'resolves font-size against the viewport and the font file' do
    session = build_session(<<~HTML)
      <!DOCTYPE html><html><head><style>
        body { margin: 0; font: 16px Arial }
        #vw { font-size: 5vw } #vmin { font-size: 1vmin }
        #ex { font-size: 2ex } #ch { font-size: 3ch }
        #probe { white-space: pre; font: 16px Arial }
      </style></head><body>
        <div id="vw"></div><div id="vmin"></div><div id="ex"></div><div id="ch"></div>
        <span id="probe">0</span>
      </body></html>
    HTML
    out = session.evaluate_script(<<~JS)
      const fs = (id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
      JSON.stringify({
        vw: fs('vw'), vmin: fs('vmin'), ex: fs('ex'), ch: fs('ch'),
        w: window.innerWidth, h: window.innerHeight,
        zero: document.getElementById('probe').getBoundingClientRect().width,
      });
    JS
    r = JSON.parse(out)
    expect(r['vw']).to be_within(0.001).of(r['w'] * 0.05)
    expect(r['vmin']).to be_within(0.001).of([r['w'], r['h']].min * 0.01)

    # `3ch` is three advances of the parent's `0` — the same figure the page renders that
    # glyph at. (`ex` has no such probe: an x-height isn't a measurable run, so it is pinned
    # only as strictly between the flat fallback and the `0` advance, which is where every
    # face here puts it.)
    expect(r['ch']).to be_within(0.001).of(r['zero'] * 3)
    skip 'no font metrics on this box — every unit falls back to 0.5em' if r['zero'] == 8
    expect(r['ex']).to be > 16          # not the flat 2 * 0.5em
    expect(r['ex']).to be < r['ch'] / 3 * 2
  end

  it 'resolves the inherited font longhands (weight / style / line-height / family)' do
    session = build_session(<<~HTML)
      <!DOCTYPE html><html><head><style>
        #bold { font-weight: bold; } #w300 { font-weight: 300; }
        #heavy { font-weight: 600; } #bolder { font-weight: bolder; }
        #italic { font-style: italic; }
        #lhnum { font-size: 16px; line-height: 1.5; }
        #lhpct { font-size: 20px; line-height: 50%; }
        #lhpx { line-height: 24px; } #lhnorm { line-height: normal; }
        #fam { font-family: Arial, "Helvetica Neue", sans-serif; }
        #outer2 { font-size: 16px; line-height: 2; }
      </style></head><body>
        <div id="bold"></div><div id="w300"></div>
        <div id="heavy"><div id="bolder"></div></div>
        <div id="italic"></div><div id="lhnum"></div><div id="lhpct"></div>
        <div id="lhpx"></div><div id="lhnorm"></div><div id="fam"></div>
        <div id="outer2"><div id="lhinherit" style="font-size: 32px">x</div></div>
      </body></html>
    HTML
    out = session.evaluate_script(<<~JS)
      const g = (id, p) => getComputedStyle(document.getElementById(id)).getPropertyValue(p);
      JSON.stringify({
        bold:   g('bold', 'font-weight'),      // 700
        w300:   g('w300', 'font-weight'),      // 300
        bolder: g('bolder', 'font-weight'),    // 900 (bolder of 600)
        italic: g('italic', 'font-style'),     // italic
        lhnum:  g('lhnum', 'line-height'),     // 24px (1.5 * 16)
        lhpct:  g('lhpct', 'line-height'),     // 10px (50% * 20)
        lhpx:   g('lhpx', 'line-height'),      // 24px
        lhnorm: g('lhnorm', 'line-height'),    // normal
        fam:    g('fam', 'font-family'),       // the list
        lhinh:  g('lhinherit', 'line-height'), // 64px (number 2 inherited, re-resolved × own 32)
      });
    JS
    r = JSON.parse(out)
    expect(r['bold']).to eq('700')
    expect(r['w300']).to eq('300')
    expect(r['bolder']).to eq('900')
    expect(r['italic']).to eq('italic')
    expect(r['lhnum']).to eq('24px')
    expect(r['lhpct']).to eq('10px')
    expect(r['lhpx']).to eq('24px')
    expect(r['lhnorm']).to eq('normal')
    expect(r['fam']).to eq('Arial, "Helvetica Neue", sans-serif')
    expect(r['lhinh']).to eq('64px')
  end

  it 'reflects stylesheet-set visibility / opacity / text-align / cursor / pointer-events' do
    session = build_session(<<~HTML)
      <!DOCTYPE html><html><head><style>
        #hidden { visibility: hidden; } #collapse { visibility: collapse; }
        #half { opacity: 0.5; } #over { opacity: 1.5; } #pctop { opacity: 50%; }
        #center { text-align: center; } #point { cursor: pointer; } #noev { pointer-events: none; }
        #vparent { visibility: hidden; }
      </style></head><body>
        <div id="hidden"></div><div id="collapse"></div>
        <div id="half"></div><div id="over"></div><div id="pctop"></div>
        <div id="center"></div><div id="point"></div><div id="noev"></div>
        <div id="vparent"><span id="vchild">x</span></div>
      </body></html>
    HTML
    out = session.evaluate_script(<<~JS)
      const g = (id, p) => getComputedStyle(document.getElementById(id)).getPropertyValue(p);
      JSON.stringify({
        hidden:   g('hidden', 'visibility'),        // hidden (from a stylesheet rule)
        collapse: g('collapse', 'visibility'),      // collapse
        vchild:   g('vchild', 'visibility'),        // hidden (inherited)
        half:     g('half', 'opacity'),             // 0.5
        over:     g('over', 'opacity'),             // 1 (clamped)
        pctop:    g('pctop', 'opacity'),            // 0.5 (percentage)
        center:   g('center', 'text-align'),        // center
        point:    g('point', 'cursor'),             // pointer
        noev:     g('noev', 'pointer-events'),      // none
      });
    JS
    r = JSON.parse(out)
    expect(r['hidden']).to eq('hidden')
    expect(r['collapse']).to eq('collapse')
    expect(r['vchild']).to eq('hidden')
    expect(r['half']).to eq('0.5')
    expect(r['over']).to eq('1')
    expect(r['pctop']).to eq('0.5')
    expect(r['center']).to eq('center')
    expect(r['point']).to eq('pointer')
    expect(r['noev']).to eq('none')
  end

  it 'reports the author display value (flex/grid/inline-block) and flexbox longhands' do
    session = build_session(<<~HTML)
      <!DOCTYPE html><html><body style="display:block"><style>
        #flex { display: flex; justify-content: center; align-items: stretch;
                align-content: space-between; flex-direction: column; flex-wrap: wrap; }
        #grid { display: grid; } #ib { display: inline-block; } #inl { display: inline; }
        #none { display: none; }
        #ord { order: 2; } #jcinit { justify-content: initial; }
      </style>
        <div id="flex"></div><div id="grid"></div><div id="ib"></div>
        <div id="inl"></div><div id="none"></div>
        <div id="unset" style="display: unset"></div>
        <div id="inherit" style="display: inherit"></div>
        <div id="ord"></div><div id="jcinit"></div>
      </body></html>
    HTML
    out = session.evaluate_script(<<~JS)
      const g = (id, p) => getComputedStyle(document.getElementById(id)).getPropertyValue(p);
      JSON.stringify({
        flex:    g('flex', 'display'),           // flex (from a stylesheet rule)
        grid:    g('grid', 'display'),           // grid
        ib:      g('ib', 'display'),             // inline-block
        inl:     g('inl', 'display'),            // inline
        none:    g('none', 'display'),           // none
        unset:   g('unset', 'display'),          // inline (display's CSS initial)
        inherit: g('inherit', 'display'),        // block (inherits body)
        jc:      g('flex', 'justify-content'),   // center
        ai:      g('flex', 'align-items'),       // stretch
        ac:      g('flex', 'align-content'),     // space-between
        fd:      g('flex', 'flex-direction'),    // column
        fw:      g('flex', 'flex-wrap'),         // wrap
        asInit:  g('grid', 'align-self'),        // auto (initial)
        ord:     g('ord', 'order'),              // 2
        jcinit:  g('jcinit', 'justify-content'), // normal (CSS-wide `initial` resolves)
      });
    JS
    r = JSON.parse(out)
    expect(r['flex']).to eq('flex')
    expect(r['grid']).to eq('grid')
    expect(r['ib']).to eq('inline-block')
    expect(r['inl']).to eq('inline')
    expect(r['none']).to eq('none')
    expect(r['unset']).to eq('inline')
    expect(r['inherit']).to eq('block')
    expect(r['jc']).to eq('center')
    expect(r['ai']).to eq('stretch')
    expect(r['ac']).to eq('space-between')
    expect(r['fd']).to eq('column')
    expect(r['fw']).to eq('wrap')
    expect(r['asInit']).to eq('auto')
    expect(r['ord']).to eq('2')
    expect(r['jcinit']).to eq('normal')
  end

  it 'reports a null parentRule and stays read-only for a computed declaration' do
    session = session_for('<div id="px">x</div>')
    out = session.evaluate_script(<<~JS)
      const cs = getComputedStyle(document.getElementById('px'));
      const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name; } };
      JSON.stringify({
        parentRule: cs.parentRule === null ? 'null' : String(cs.parentRule),
        setProp:    err(() => cs.setProperty('color', 'red')),
      });
    JS
    r = JSON.parse(out)
    expect(r['parentRule']).to eq('null')
    expect(r['setProp']).to eq('NoModificationAllowedError')
  end
end
