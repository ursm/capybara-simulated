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
end
