require 'capybara/simulated'
require_relative 'support/session_teardown'

# A form's past names map (HTML §4.10.3, element_state.rs `form_named_item`): a name the named getter answered with one
# element keeps answering with it after the element is renamed — until it changes form owner — and the supported
# property names list them after that element's own id and name, element by element in tree order. Chrome 155: an input
# renamed and then made an image button (no named element now, its form owner the same) still answers `f.x`.
RSpec.describe 'a form past names map' do
  it 'keeps a renamed control until it changes form owner' do
    s = simulated_session(->(_env) {
      [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><form id=f><input id=a name=x><input id=b name=z></form><form id=g></form>']]
    })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const f = document.getElementById('f'), a = document.getElementById('a');
        f.x;
        a.name = 'y';
        const renamed = f.x === a;
        a.type = 'image';
        const imaged = f.x === a;
        const names = Object.getOwnPropertyNames(f).filter((k) => /^[a-z]/.test(k));
        a.type = 'text';
        document.getElementById('g').appendChild(a);
        return [renamed, imaged, names, f.x];
      })()
    JS
    expect(got).to eq([true, true, ['x', 'b', 'z'], nil])
  end
end
