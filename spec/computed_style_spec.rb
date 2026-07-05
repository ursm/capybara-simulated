# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# getComputedStyle resolution for layout-free values: the inherited font longhands
# (`font-size` / `font-weight` / `font-style` / `line-height` / `font-family` — commonly read
# by app JS, and which the canvas em/rem/lh path depends on) and the `parentRule` of a
# computed declaration.
RSpec.describe 'getComputedStyle font longhands + parentRule' do
  # Serve a full HTML document and return a visited session.
  def build_session(html)
    app = Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] }
    }.to_app
    Capybara.app = app
    session = Capybara::Session.new(:simulated, app)
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
