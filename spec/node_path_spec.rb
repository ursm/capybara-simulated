require 'capybara/simulated'
require_relative 'support/session_teardown'

# Capybara's `Node#path` (xpath.rs `node_path`), Selenium's and Cuprite's shape: each element by its local name and its
# position among its parent's element children of that name; the marker string for an element in a shadow tree.
RSpec.describe 'Node#path' do
  it "names each element by its position among its namesakes" do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><div></div><p>a</p><div><span>x</span><span id=t>y</span></div><div id=h></div>']]
    })
    s.visit '/'
    s.execute_script("document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = '<b>in</b>'")
    expect(s.find('#t').path).to eq('/html[1]/body[1]/div[2]/span[2]')
    expect(s.find('#h').shadow_root.find('b').path).to eq('(: Shadow DOM element - no XPath :)')
  end

  # Every element's path finds it again (Capybara's "#path returns xpath which points to itself"): an SVG or MathML
  # element, and an HTML one made with an uppercase local name, by Selenium's `local-name()` form.
  it 'gives a path that finds the element again, foreign or oddly named' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><div>a</div><svg><g></g><foreignObject><p id=fp>x</p></foreignObject></svg><math><mi>y</mi></math><span id=host></span>']]
    })
    s.visit '/'
    s.execute_script("document.getElementById('host').appendChild(document.createElementNS('http://www.w3.org/1999/xhtml', 'DIV')).id = 'up'")
    ['g', 'mi', '#fp', '#up'].each do |css|
      el = s.find(:css, css)
      expect(s.find(:xpath, el.path)).to eq(el), css
    end
    expect(s.find(:css, 'g').path).to eq("/html[1]/body[1]/*[local-name()='svg' and namespace-uri()='http://www.w3.org/2000/svg'][1]/*[local-name()='g' and namespace-uri()='http://www.w3.org/2000/svg'][1]")
  end
end
