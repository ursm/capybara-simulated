require 'capybara/simulated'
require 'rack'

# The cascade matches selectors LIVE on every read — that is how a DYNAMIC pseudo-class takes effect
# at all. Anything that CACHES a cascade result therefore has to be invalidated by every input those
# selectors read, and most of them already move `settleGen` (an attribute, the tree, a form control's
# checkedness, the location) or `cascadeVersion` (a stylesheet). The ones that move NEITHER are what
# this file pins: a caching attempt that missed them turned eight WPT subtests red, and each of the
# cases below is one of those.
RSpec.describe 'cascade invalidation' do
  def session(body)
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, [body]] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  # Every case reads the property FIRST (populating any cache), then mutates, then reads again.
  # Reading first is the whole point — a cache that is only ever cold cannot go stale.
  it 'updates style when a custom element STATE changes' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        x-el { color: rgb(0, 0, 0) }
        x-el:state(on) { color: rgb(0, 128, 0) }
      </style></head>
      <body><x-el id="e"></x-el></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        class XEl extends HTMLElement {
          constructor() { super(); this._i = this.attachInternals(); }
        }
        customElements.define('x-el', XEl);
        const el = document.getElementById('e');
        const read = () => getComputedStyle(el).color;
        const before = read();
        el._i.states.add('on');
        const on = read();
        el._i.states.delete('on');
        return [before, on, read()];
      })()
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)', 'rgb(0, 0, 0)'])
  end

  it 'updates style when FOCUS moves' do
    # `document._activeElement` is assigned from a dozen places, so this one is DERIVED rather than
    # signalled — the generation compares the value instead of trusting every writer to announce it.
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        input { color: rgb(0, 0, 0) }
        input:focus { color: rgb(255, 0, 0) }
        .box { color: rgb(0, 0, 0) }
        .box:focus-within { color: rgb(0, 0, 255) }
      </style></head>
      <body><div class="box" id="b"><input id="i"></div></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const i = document.getElementById('i'), b = document.getElementById('b');
        const read = () => [getComputedStyle(i).color, getComputedStyle(b).color];
        const before = read();
        i.focus();
        const focused = read();
        i.blur();
        return [before, focused, read()];
      })()
    JS
    expect(got).to eq([['rgb(0, 0, 0)', 'rgb(0, 0, 0)'], ['rgb(255, 0, 0)', 'rgb(0, 0, 255)'], ['rgb(0, 0, 0)', 'rgb(0, 0, 0)']])
  end

  it 'updates style when a custom element becomes DEFINED' do
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>
        y-el { color: rgb(0, 0, 0) }
        y-el:defined { color: rgb(0, 128, 0) }
      </style></head>
      <body><y-el id="y"></y-el></body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const el = document.getElementById('y');
        const before = getComputedStyle(el).color;
        customElements.define('y-el', class extends HTMLElement {});
        return [before, getComputedStyle(el).color];
      })()
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'updates style when a shadow root ADOPTS a sheet in place' do
    # An in-place mutation of the ObservableArray, not a reassignment: the setter already invalidated,
    # the array mutators did not move any generation.
    s = session('<!DOCTYPE html><html><body><div id="h"></div></body></html>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const host = document.getElementById('h');
        const sr = host.attachShadow({mode: 'open'});
        sr.innerHTML = '<p id="p">x</p>';
        const p = sr.getElementById('p');
        const before = getComputedStyle(p).color;
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('p { color: rgb(0, 128, 0) }');
        sr.adoptedStyleSheets.push(sheet);
        return [before, getComputedStyle(p).color];
      })()
    JS
    expect(got).to eq(['rgb(0, 0, 0)', 'rgb(0, 128, 0)'])
  end

  it 'updates style when a combobox filter hides an option' do
    # `:filtered` is a driver-internal cascade input — the option a combobox filter hides — with no
    # attribute behind it. The filter re-runs from the `value` IDL setter, so this reads first, then
    # filters, then reads again.
    #
    # Honest note: that setter ALSO routes through setAttribute, which moves `settleGen`, so the
    # style-state signal on `_filtered` is currently redundant. It is kept so the invariant lives on
    # the flag ("a cascade input signals when it moves") instead of resting on a coincidence a future
    # refactor of the value path could remove without anyone noticing.
    s = session(<<~HTML)
      <!DOCTYPE html>
      <html><head><style>option:filtered { display: none }</style></head>
      <body>
        <input id="i" list="dl"><datalist id="dl">
          <option id="o1">alpha</option><option id="o2">beta</option>
        </datalist>
      </body></html>
    HTML
    got = s.evaluate_script(<<~JS)
      (() => {
        const d = id => getComputedStyle(document.getElementById(id)).display;
        const before = [d('o1'), d('o2')];
        document.getElementById('i').value = 'al';
        return [before, [d('o1'), d('o2')]];
      })()
    JS
    expect(got).to eq([%w[block block], %w[block none]])
  end
end
