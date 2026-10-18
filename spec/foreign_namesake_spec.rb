require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element that only shares an HTML element's local name — a MathML `<form>`, an SVG `<datalist>` — is not that HTML
# element, and nothing the HTML element does it does. Chrome: a submit bubbles through a MathML `<form>` around its form
# to the body, and `list` naming an SVG `<datalist>` is null.
RSpec.describe 'a foreign element named like an HTML one' do
  it 'neither ends a submit event nor answers an input list' do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset="utf-8"><body>']] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const outer = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'form');
        const form = document.createElement('form');
        outer.append(form);
        document.body.append(outer);
        let reached = false;
        document.body.addEventListener('submit', (e) => { reached = true; e.preventDefault(); });
        form.requestSubmit();
        const list = document.createElementNS('http://www.w3.org/2000/svg', 'datalist');
        list.id = 'l';
        const input = document.createElement('input');
        input.setAttribute('list', 'l');
        document.body.append(list, input);
        return [reached, input.list];
      })()
    JS
    expect(got).to eq([true, nil])
  end
end
