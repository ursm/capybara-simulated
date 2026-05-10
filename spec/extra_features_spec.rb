require 'capybara/simulated'

# Default feature set carries URL / Encoding / Crypto. `POLYFILL_INTL`
# costs ~140 ms at VM construction (FormatJS locale tables + IANA TZ);
# bundles that need it (Avo's flatpickr / luxon, etc.) opt in via
# `Driver.new(features: [Quickjs::POLYFILL_INTL])`. This spec locks
# both halves of that contract so a refactor that severs the chain
# fails loudly.
RSpec.describe 'extra QuickJS feature flags' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']]
    end
  }

  it 'pins URL / Encoding / Crypto by default and leaves Intl / File absent' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    have = session.evaluate_script(<<~JS)
      ({
        URL:           typeof URL,
        TextEncoder:   typeof TextEncoder,
        randomUUID:    typeof crypto?.randomUUID,
        Intl:          typeof Intl,
        // POLYFILL_FILE registers QuickJS's native Blob; we ship a
        // JS-side stub instead, so Blob is always present but it's
        // not the QuickJS one.
        Blob:          typeof Blob
      })
    JS
    expect(have).to include(
      'URL'         => 'function',
      'TextEncoder' => 'function',
      'randomUUID'  => 'function',
      'Intl'        => 'undefined',
      'Blob'        => 'function'
    )
  end

  it 'formats currency via Intl.NumberFormat when POLYFILL_INTL is opted in' do
    Capybara.register_driver :simulated_with_intl do |a|
      Capybara::Simulated::Driver.new(a, features: [Quickjs::POLYFILL_INTL])
    end
    session = Capybara::Session.new(:simulated_with_intl, app)
    session.visit '/'
    formatted = session.evaluate_script(<<~JS)
      new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(1234.5)
    JS
    expect(formatted).to eq('$1,234.50')
  end

  it 'extends with extra features without dropping the defaults' do
    Capybara.register_driver :simulated_with_extras do |a|
      Capybara::Simulated::Driver.new(a, features: [Quickjs::POLYFILL_FILE, Quickjs::POLYFILL_INTL])
    end
    session = Capybara::Session.new(:simulated_with_extras, app)
    session.visit '/'
    have = session.evaluate_script(<<~JS)
      ({ URL: typeof URL, Intl: typeof Intl })
    JS
    expect(have['URL']).to  eq('function')
    expect(have['Intl']).to eq('object')
  end
end
