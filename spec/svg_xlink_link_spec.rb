# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An SVG `<a>` is a hyperlink with an `href` in no namespace or, failing that, an XLink one — parsed as `xlink:href`, or
# set by `setAttributeNS(XLINK, 'href', …)` with no prefix, which is how libraries write it. Such an `<a>` matches
# `:any-link` / `:link` (in the native matcher, which reads the attribute's namespace, and in css-select), is
# focusable, and navigates when clicked. Chrome-measured.
RSpec.describe 'SVG XLink links' do
  PAGE = <<~HTML
    <!DOCTYPE html><svg id="s"><a id="pa" xlink:href="/x"><text>p</text></a></svg>
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
        return [a.matches(':any-link'), a.matches(':link'), document.getElementById('pa').matches(':any-link'),
                document.querySelectorAll(':any-link').length, a.tabIndex];
      })()
    JS
    expect(got).to eq([true, true, true, 2, 0])
  end

  it 'navigates when clicked' do
    s = session
    s.find(:css, '#lnk').click
    expect(s).to have_current_path('/next')
  end
end
