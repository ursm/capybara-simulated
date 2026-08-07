require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# A declaration whose VALUE the property's grammar doesn't admit is not a declaration: a browser
# drops it at parse time, leaving whatever was there before. We used to keep it, so
# `style.width = undefined` left `width: undefined` in the attribute — a value no browser has, which
# then flowed into the cascade and the layout. Every expectation here is real Chrome's, read off the
# same assignments with `--headless --dump-dom`.
RSpec.describe 'invalid declaration values' do
  def after_setting(script)
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="d"></div></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    s.evaluate_script(<<~JS)
      (() => {
        const d = document.getElementById('d');
        d.removeAttribute('style');
        #{script}
        return d.getAttribute('style') || '';
      })()
    JS
  end

  it 'drops a value the property does not admit' do
    expect(after_setting("d.style.width = 'notalength';")).to eq('')
    expect(after_setting("d.style.display = 'blockish';")).to eq('')
    expect(after_setting("d.style.color = 'notacolor';")).to eq('')
    expect(after_setting("d.style.zIndex = '1.5';")).to eq('')
    expect(after_setting("d.style.width = '100';")).to eq('')      # a length needs a unit
  end

  it 'drops what a JS value stringifies into' do
    expect(after_setting('d.style.width = undefined;')).to eq('')
    expect(after_setting('d.style.width = {};')).to eq('')          # "[object Object]"
    expect(after_setting('d.style.width = 100;')).to eq('')         # "100", no unit
    expect(after_setting("d.style.setProperty('width', undefined);")).to eq('')
  end

  it 'leaves the previous declaration standing' do
    # The invalid assignment is a no-op, not a removal.
    expect(after_setting("d.style.width = '5px'; d.style.width = 'nope';")).to eq('width: 5px;')
  end

  it 'still accepts everything a browser does' do
    expect(after_setting("d.style.width = 'fit-content';")).to eq('width: fit-content;')
    expect(after_setting("d.style.width = 'calc(100% - 10px)';")).to eq('width: calc(100% - 10px);')
    expect(after_setting("d.style.width = 'var(--x)';")).to eq('width: var(--x);')
    expect(after_setting("d.style.position = 'sticky';")).to eq('position: sticky;')
    expect(after_setting("d.style.color = 'color-mix(in srgb, red, blue)';"))
      .to eq('color: color-mix(in srgb, red, blue);')
    # A legacy keyword mdn's grammar data omits, which browsers do accept.
    expect(after_setting("d.style.outlineColor = 'invert';")).to eq('outline-color: invert;')
    # `null` and '' are the CSSOM's clear path, not an invalid value.
    expect(after_setting("d.style.width = '5px'; d.style.width = null;")).to eq('')
  end

  it 'never judges a value it has no grammar for' do
    # A CUSTOM property is an arbitrary token stream, and mdn carries no data for vendor-prefixed
    # properties or values — `display: -webkit-box` is the canonical multiline-truncation pair with
    # `-webkit-line-clamp`, and every browser keeps it.
    expect(after_setting("d.style.setProperty('--state', 'collapsed');")).to eq('--state: collapsed;')
    expect(after_setting("d.style.display = '-webkit-box';")).to eq('display: -webkit-box;')
    expect(after_setting("d.style.setProperty('-webkit-font-smoothing', 'antialiased');"))
      .to eq('-webkit-font-smoothing: antialiased;')
  end

  it 'does not treat a vendor prefix as a blank cheque' do
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body></body></html>']] }
    s = simulated_session(app)
    s.visit '/'
    # An unknown `-webkit-…` is not a property — Chrome says false — while the handful of prefixed
    # names browsers DO implement and mdn omits are listed explicitly.
    expect(s.evaluate_script("[CSS.supports('-webkit-nope', 'x'), CSS.supports('-webkit-font-smoothing', 'antialiased')]"))
      .to eq([false, true])
  end

  it 'keeps a shipped value mdn has no entry for yet' do
    # Customizable Select's `appearance: base-select` is shipped and absent from mdn's grammar data,
    # so the keyword table alone would drop it.
    expect(after_setting("d.style.appearance = 'base-select';")).to eq('appearance: base-select;')
  end
end
