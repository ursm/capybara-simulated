# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A checked radio button inserted unchecks the rest of its group, the last in tree order winning (HTML §4.10.5.1.15,
# "the element is inserted") — whichever way it is inserted, the parser's way too (Chrome: `[false, true, …]`).
RSpec.describe 'the radio buttons\' insertion steps' do
  let(:page_html) {
    '<!DOCTYPE html><meta charset=utf-8><body><form><input type=radio name=a id=a1 checked>' \
      '<input type=radio name=a id=a2 checked></form><div id=d></div>'
  }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page_html]] }) }

  it 'unchecks the rest of the group as a checked one is parsed, set as HTML or appended' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const r = [a1.checked, a2.checked];
        d.innerHTML = '<input type=radio name=b id=b1 checked><input type=radio name=b id=b2 checked>';
        r.push(b1.checked, b2.checked);
        const f = document.createElement('div');
        f.innerHTML = '<input type=radio name=a id=a3 checked>';
        document.querySelector('form').append(f);
        r.push(a1.checked, a2.checked, a3.checked);
        return r;
      })()
    JS
    expect(got).to eq([false, true, false, true, false, false, true])
  end

  # The steps run as a `checked` is added to a radio whose checkedness is not dirty, and they make dirty only the one they
  # uncheck: one never checked keeps following its attribute (Chrome and Firefox).
  it 'unchecks the checked rest of the group as a checked attribute is added, leaving the others clean' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        d.innerHTML = '<input type=radio name=c id=c1><input type=radio name=c id=c2 checked>';
        const r = [];
        c2.removeAttribute('checked');
        c1.setAttribute('checked', '');
        r.push(c1.checked, c2.checked);
        c2.defaultChecked = true;
        r.push(c1.checked, c2.checked);
        return r;
      })()
    JS
    expect(got).to eq([true, false, false, true])
  end

  # A radio in a shadow tree "becomes connected" with its host: the host's insertion runs its steps.
  it 'runs the steps of the radios in a shadow tree as its host is connected' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const host = document.createElement('div');
        const a = document.createElement('input'), b = document.createElement('input');
        for (const x of [a, b]) { x.type = 'radio'; x.name = 'z'; x.checked = true; }
        host.attachShadow({mode: 'open'}).append(a, b);
        const before = [a.checked, b.checked];
        d.append(host);
        return [before, [a.checked, b.checked]];
      })()
    JS
    expect(got).to eq([[true, true], [false, true]])
  end

  # A radio's checkedness set to true unchecks the rest of its group whatever set it — a form's reset, which sets each
  # one's anew, the last winning — and in whatever tree it is (Chrome and Firefox).
  it 'unchecks the rest of the group as a reset or a detached tree\'s attribute checks one' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const f = document.querySelector('form');
        f.reset();
        const r = [a1.checked, a2.checked];
        const d = document.createElement('div');
        d.innerHTML = '<input type=radio name=z checked><input type=radio name=z>';
        const [x, y] = d.children;
        y.setAttribute('checked', '');
        r.push(x.checked, y.checked);
        return r;
      })()
    JS
    expect(got).to eq([false, true, false, true])
  end
end
