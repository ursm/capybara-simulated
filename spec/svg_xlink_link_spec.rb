# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An SVG `<a>` is a hyperlink with an `href` in no namespace or, failing that, an XLink one — parsed as `xlink:href`, or
# set by `setAttributeNS(XLINK, 'href', …)` with no prefix, which is how libraries write it. Such an `<a>` matches
# `:any-link` / `:link` (in the native matcher, which reads the attribute's namespace, and in css-select), is
# focusable, and navigates when clicked. A `<link href>` is no hyperlink to either (HTML "selectors"). Chrome-measured.
RSpec.describe 'SVG XLink links' do
  PAGE = <<~HTML
    <!DOCTYPE html><link id="l" rel="help" href="/h"><style>:any-link { --m: 1 }</style>
    <svg id="s"><a id="pa" xlink:href="/x"><text>p</text></a></svg>
    <script>
      const a = document.createElementNS('http://www.w3.org/2000/svg', 'a');
      a.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '/next');
      a.id = 'lnk';
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('y', '20'); t.textContent = 'go';
      a.append(t);
      document.getElementById('s').append(a);
    </script>
  HTML

  def session
    app = ->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/next' ? '<p>next</p>' : PAGE]] }
    s = simulated_session(app)
    s.visit '/'
    s
  end

  it 'matches :any-link and is focusable' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const a = document.getElementById('lnk');
        const l = document.getElementById('l'), m = (e) => getComputedStyle(e).getPropertyValue('--m').trim();
        return [a.matches(':any-link'), a.matches(':link'), document.getElementById('pa').matches(':any-link'),
                document.querySelectorAll(':any-link').length, a.tabIndex, l.matches(':any-link'), m(l), m(a)];
      })()
    JS
    expect(got).to eq([true, true, true, 2, 0, false, '', '1'])
  end

  # An `<a>` in NO namespace is no hyperlink — not to the native matcher (the cascade), not to css-select, and it gets
  # no UA link colour — while `:-webkit-any-link` is Chrome's other name for `:any-link`. Chrome-measured.
  it 'makes no hyperlink of an <a> in no namespace, and knows :-webkit-any-link' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const t = document.createElement('div');
        t.className = 't';
        document.body.append(t);
        const st = document.createElement('style');
        st.textContent = '.t :any-link { outline-color: rgb(1, 2, 3) }';
        document.head.append(st);
        const n = document.createElementNS(null, 'a'); n.setAttribute('href', '/x'); t.append(n);
        const h = document.createElement('a'); h.href = '/y'; t.append(h);
        return [n.matches(':any-link'), getComputedStyle(n).outlineColor, getComputedStyle(n).color,
                getComputedStyle(h).color, h.matches(':-webkit-any-link')];
      })()
    JS
    expect(got).to eq([false, 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 238)', true])
  end

  it 'navigates when clicked' do
    s = session
    s.find(:css, '#lnk').click
    expect(s).to have_current_path('/next')
  end
end
