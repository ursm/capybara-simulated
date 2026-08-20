require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'
require_relative 'support/js_engine'

# Layout reuses a subtree across a bare style-state bump (focus, checkedness) when no dynamic
# rule can target it — `subtreeDynFree` / `ancestorsDynFree` in layout.js. That optimization is
# a claim about REACHABILITY: any box a dynamic rule can move, directly, through inheritance, or
# through the flow around it, must still re-lay-out. Every case here reads geometry BEFORE the
# state change, because a cache that is only ever cold cannot serve stale.
RSpec.describe 'layout reuse across dynamic style state' do
  def session_for(css, body)
    html = "<!DOCTYPE html><html><head><style>#{css}</style></head><body>#{body}</body></html>"
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [html]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  it 'resizes the focused element itself' do
    s = session_for(
      '#t { width: 100px } #t:focus { width: 300px }',
      '<input id="t">'
    )
    read = "document.getElementById('t').getBoundingClientRect().width"
    expect(s.evaluate_script(read)).to eq(100)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(300)
  end

  it 'resizes a child that inherits from an ancestor whose rule is dynamic' do
    # The child carries no dynamic candidate of its own — only the ANCESTOR walk can know its
    # `em` basis moved. This is the case `ancestorsDynFree` exists for.
    s = session_for(
      '#wrap { font-size: 10px } #wrap:focus-within { font-size: 32px }',
      '<div id="wrap"><input id="i"><div id="c" style="width: 2em">x</div></div>'
    )
    read = "document.getElementById('c').getBoundingClientRect().width"
    expect(s.evaluate_script(read)).to eq(20)
    s.evaluate_script("document.getElementById('i').focus()")
    expect(s.evaluate_script(read)).to eq(64)
  end

  it 'moves a static sibling below an element the state change grew' do
    # The sibling itself is dyn-free and its subtree is untouched — but the box ABOVE it grew,
    # so its position must move even though its own layout is reused.
    s = session_for(
      '#t { height: 20px } #t:focus { height: 100px } div { margin: 0 }',
      '<input id="t"><div id="below">x</div>'
    )
    read = "document.getElementById('below').getBoundingClientRect().top"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(before + 80)
  end

  it 'reveals a hidden sibling through a dynamic hide rule and reflows below it' do
    s = session_for(
      '#panel { display: none; height: 50px } #t:checked ~ #panel { display: block }',
      '<input type="checkbox" id="t"><div id="panel"></div><div id="below">x</div>'
    )
    read = "document.getElementById('below').getBoundingClientRect().top"
    before = s.evaluate_script(read)
    s.find('#t').click
    expect(s.evaluate_script(read)).to eq(before + 50)
  end

  it 'moves boxes under a :has() whose argument is a dynamic pseudo' do
    # `:has(:checked)` reads checkedness — state no mutation record tracks — so the rule must
    # count as dynamic even though `:has` itself is structural.
    s = session_for(
      '#wrap { padding-top: 0 } #wrap:has(:checked) { padding-top: 40px }',
      '<div id="wrap"><input type="checkbox" id="t"><div id="c">x</div></div>'
    )
    read = "document.getElementById('c').getBoundingClientRect().top"
    before = s.evaluate_script(read)
    s.find('#t').click
    expect(s.evaluate_script(read)).to eq(before + 40)
  end

  it 'honours a dynamic ancestor rule whose ancestor class arrived after the subtree was laid out' do
    # The adversary for any memoised "no dynamic rule reaches this subtree" verdict: the verdict
    # is computed while no `.menu` ancestor exists, then the class ARRIVES (which dirties the
    # ancestor chain downward not at all), and only then does the dynamic state change. A memo
    # keyed without ancestor context serves the pre-`.menu` answer here — the exact hole a
    # review found in a (since-reverted) reuse optimization.
    s = session_for(
      '.menu:hover .item { margin-left: 40px }',
      '<div id="p"><div id="c"><span class="item" id="t">x</span></div></div>'
    )
    read = "document.getElementById('t').getBoundingClientRect().left"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('p').classList.add('menu')")
    expect(s.evaluate_script(read)).to eq(before)
    s.evaluate_script("document._hoverElement = document.getElementById('p')")
    expect(s.evaluate_script(read)).to eq(before + 40)
  end

  it 'keeps a dyn-free subtree correct (and identical) across an unrelated focus change' do
    s = session_for(
      '#t:focus { width: 300px } td { width: 40px; height: 10px }',
      '<input id="t"><table id="tbl"><tr><td>a</td><td>b</td></tr></table>'
    )
    read = "JSON.stringify(document.querySelector('#tbl td').getBoundingClientRect())"
    before = s.evaluate_script(read)
    s.evaluate_script("document.getElementById('t').focus()")
    expect(s.evaluate_script(read)).to eq(before)
  end
end
