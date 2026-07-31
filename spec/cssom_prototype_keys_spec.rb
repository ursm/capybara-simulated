require 'capybara/simulated'

# Every map the CSSOM keys by a property NAME is looked up with a name that came from page script
# (`getComputedStyle(el).constructor`, `getPropertyValue('valueOf')`, `style.hasOwnProperty = …`).
# A plain object literal answers those with an inherited Object.prototype member, which then reads
# as a declaration that is present and gets handled as if it were a CSS value.
RSpec.describe 'CSSOM property maps are prototype-less' do
  def session
    app = lambda {|_env| [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><body><div id="d">x</div></body></html>']] }
    s = Capybara::Session.new(:simulated, app)
    s.visit '/'
    s
  end

  # A property-keyed map looked up with a name from page script must not answer with an
  # Object.prototype member — `getComputedStyle(el).constructor` has to stay the interface, and a
  # write / read named after one must not throw.
  it 'does not leak Object.prototype members as CSS values' do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq(['CSSStyleDeclaration', 'function', '', '', 'ok'])
      (() => {
        const el = document.getElementById('d');
        const c = getComputedStyle(el);
        const out = [
          c.constructor && c.constructor.name,       // the interface, not Object
          typeof c.valueOf,                          // still a function, not a CSS value string
          c.getPropertyValue('constructor'),         // a miss, not "function Object() {…}"
          c.getPropertyValue('valueOf')
        ];
        // A write named after one must not throw on the declaration map either.
        try { el.style.setProperty('constructor', 'red'); el.style.hasOwnProperty = '1px'; out.push('ok'); }
        catch (e) { out.push('threw: ' + e.message); }
        return out;
      })()
    JS
  end
end
