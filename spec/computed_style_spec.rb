# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# getComputedStyle resolution for layout-free values: `font-size` (a very commonly-read
# property that resolves relative units against the inherited parent size, and which the
# canvas em/rem/lh path depends on) and the `parentRule` of a computed declaration.
RSpec.describe 'getComputedStyle font-size + parentRule' do
  def session_for(body_html)
    html = <<~HTML
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
    app = Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, [html]] }
    }.to_app
    Capybara.app = app
    session     = Capybara::Session.new(:simulated, app)
    session.visit '/'
    session
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
