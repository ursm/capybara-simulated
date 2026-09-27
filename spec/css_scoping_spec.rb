# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# css-scoping's pseudo-classes and pseudo-elements that reach across a shadow boundary.
RSpec.describe 'css-scoping selectors' do
  # `::slotted()` and `:host()` take a `<compound-selector>`: an argument with a combinator or a list makes the selector
  # invalid, and it matches nothing. Both were applied as written — the slotted `li` and the host moved 40px where
  # Chrome leaves them at 0.
  it 'ignores ::slotted() and :host() whose argument is not one compound selector' do
    html = '<!DOCTYPE html><body style="margin:0"><div id="h"><li class="x">x</li><li id="b">y</li></div>' \
           '<div id="h2" class="b"><p id="q" style="margin:0">q</p></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = '<style>::slotted(.x + li) { margin-left: 40px }</style><slot></slot>';
        document.getElementById('h2').attachShadow({mode: 'open'}).innerHTML = '<style>:host(div, .b) { margin-left: 40px }</style><slot></slot>';
        return ['b', 'q'].map((id) => document.getElementById(id).getBoundingClientRect().x);
      })()
    JS
    expect(got).to eq([0, 0])
  end

  # A `:host` compound LEFT of a combinator matches the host as every in-tree element's shadow-including ancestor
  # (§3.2.1): `:host p` is the tree's `p`, `:host > p` its top-level one, `:host(.x) p` the tree's `p` while the host is
  # `.x`; the host has no sibling in its tree and no ancestor in it, so `:host + p` and `.a :host p` match nothing. None
  # of them matched at all. Chrome, the per-element figures below, and after the host's class becomes `y`.
  it 'matches a :host compound on the left of a combinator' do
    html = '<!DOCTYPE html><body style="margin:0"><div id="h" class="x"></div><div id="h2"></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const css = ':host p { margin-left: 10px } :host(.x) p { padding-left: 2px } :host > p { border-left: 1px solid } ' +
                    ':host(.x) > div p { margin-top: 3px } :host + p { margin-right: 7px } .a :host p { margin-bottom: 9px } ' +
                    ':host div p { padding-top: 4px } :host(.y) p { padding-right: 5px }';
        const html = '<style>' + css + '</style><p id="a">a</p><div><p id="b">b</p></div>';
        const r1 = document.getElementById('h').attachShadow({mode: 'open'}); r1.innerHTML = html;
        const r2 = document.getElementById('h2').attachShadow({mode: 'open'}); r2.innerHTML = html;
        const g = (r, id) => { const s = getComputedStyle(r.getElementById(id));
          return [s.marginLeft, s.paddingLeft, s.borderLeftWidth, s.marginTop, s.marginRight, s.marginBottom, s.paddingTop, s.paddingRight].join(' '); };
        const out = [g(r1, 'a'), g(r1, 'b'), g(r2, 'a'), g(r2, 'b')];
        document.getElementById('h').className = 'y';
        out.push(g(r1, 'a'));
        return out;
      })()
    JS
    expect(got).to eq(['10px 2px 1px 16px 0px 16px 0px 0px', '10px 2px 0px 3px 0px 16px 4px 0px',
                       '10px 0px 1px 16px 0px 16px 0px 0px', '10px 0px 0px 16px 0px 16px 4px 0px',
                       '10px 0px 1px 16px 0px 16px 0px 5px'])
  end

  # …and the host's class written by a PARSE-TIME script after a layout read: the layout gate had no rule set collected
  # yet, kept the write for a rebuild that was not coming, and the tree under the host kept its old padding.
  it 'relays out the tree under a host whose class a parse-time script changes' do
    script = "const h = document.getElementById('h'), r = h.attachShadow({mode: 'open'}); " \
             "r.innerHTML = '<style>:host(.x) p { padding-left: 2px } :host(.y) p { padding-right: 5px }</style><p id=a>a</p>'; " \
             "getComputedStyle(r.getElementById('a')).marginLeft; h.className = 'y'; " \
             "const s = getComputedStyle(r.getElementById('a')); window.R = [s.paddingLeft, s.paddingRight];"
    html = "<!DOCTYPE html><body><div id=\"h\" class=\"x\"></div><script>#{script}</script></body>"
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    expect(s.evaluate_script('window.R')).to eq(%w[0px 5px])
  end
end
