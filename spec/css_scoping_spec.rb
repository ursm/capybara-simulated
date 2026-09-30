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

  # A `:host` or `::slotted()` rule is written in the tree one boundary IN from the element it styles, and the cascade
  # sorts on that CONTEXT before specificity or order (css-cascade-5 §6.1): the document's NORMAL declaration beats it,
  # its `!important` one beats the document's. Chrome and Firefox: 20px, 120px, red — where the shadow rule won all three.
  [nil, '1'].each do |stylo|
    it "sorts a :host and a ::slotted() rule on context against the document's#{stylo ? ' (stylo)' : ''}" do
      saved = ENV['CSIM_STYLO']
      ENV['CSIM_STYLO'] = stylo
      html = '<!DOCTYPE html><style>#a { display: block; height: 20px } #b { display: block; height: 20px !important } ' \
             '#c { color: rgb(255, 0, 0) }</style><div id="a"></div><div id="b"></div><div id="h"><span id="c">c</span></div>'
      s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
      s.visit '/'
      got = s.evaluate_script(<<~JS)
        (() => {
          document.getElementById('a').attachShadow({mode: 'open'}).innerHTML = '<style>:host { height: 120px }</style>';
          document.getElementById('b').attachShadow({mode: 'open'}).innerHTML = '<style>:host { height: 120px !important }</style>';
          document.getElementById('h').attachShadow({mode: 'open'}).innerHTML = '<style>::slotted(#c) { color: rgb(0, 128, 0) }</style><slot></slot>';
          const cs = (id) => getComputedStyle(document.getElementById(id));
          return [cs('a').height, cs('b').height, cs('c').color, document.getElementById('a').getBoundingClientRect().height];
        })()
      JS
      expect(got).to eq(['20px', '120px', 'rgb(255, 0, 0)', 20])
    ensure
      ENV['CSIM_STYLO'] = saved
    end
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

  # …and only `:host` itself: a featureless host matches no other pseudo-class beside it (`:host:not(.q) p`,
  # `:host(.x):not(.y) p`), and `:host()` does not take `:has()`; `:where(:host)` / `:is(:host)` are `:host`. Chrome:
  # 0, 0, 0, 11, 12.
  it 'takes :host alone as the host, and nothing beside it' do
    html = '<!DOCTYPE html><body></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      [':host:not(.q) p { margin-left: 5px }', ':host(.x):not(.y) p { margin-left: 3px }',
       ':host(:has(.f)) p { margin-left: 23px }', ':where(:host) p { margin-left: 11px }',
       ':is(:host) p { margin-left: 12px }'].map((css) => {
        const h = document.createElement('div'); h.className = 'x'; h.innerHTML = '<i class="f"></i>';
        document.body.appendChild(h);
        const r = h.attachShadow({mode: 'open'});
        r.innerHTML = '<style>' + css + '</style><p id="p">x</p>';
        return parseFloat(getComputedStyle(r.getElementById('p')).marginLeft);
      })
    JS
    expect(got).to eq([0, 0, 0, 11, 12])
  end

  # A `:host()` reading the host's POSITION or `:empty` flips on a child-list change beside or under the host, with no
  # write to the host itself: a sibling prepended (`:first-child`), appended (`:last-child`), the only light child
  # removed (`:empty`). Chrome: 40, 40, 0, then 0, 0, 40.
  it 'relays out the tree under a host whose position or emptiness changes' do
    html = '<!DOCTYPE html><body style="margin:0"><div id="w1"><div id="h1"></div></div><div id="w2"><div id="h2"></div></div>' \
           '<div id="h3"><b id="only">x</b></div></body>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [html]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const mk = (id, css) => {
          const r = document.getElementById(id).attachShadow({mode: 'open'});
          r.innerHTML = '<style>' + css + '</style><p id="p" style="margin-top:0">x</p><slot></slot>';
          return () => r.getElementById('p').getBoundingClientRect().x - document.getElementById(id).getBoundingClientRect().x;
        };
        const a = mk('h1', ':host(:first-child) p { margin-left: 40px }'), b = mk('h2', ':host(:last-child) p { margin-left: 40px }'),
              c = mk('h3', ':host(:empty) p { margin-left: 40px }');
        const out = [a(), b(), c()];
        document.getElementById('w1').prepend(document.createElement('i'));
        document.getElementById('w2').append(document.createElement('i'));
        document.getElementById('only').remove();
        return out.concat([a(), b(), c()]);
      })()
    JS
    expect(got).to eq([40, 40, 0, 0, 0, 40])
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
