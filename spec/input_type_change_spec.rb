require 'capybara/simulated'

# HTML "input type change" value-mode migration. The live IDL value (`_value`)
# is separate from the `value` content attribute; a "default"/"default-on" type
# (radio/checkbox/hidden/submit/…) exposes `value` via the content attribute. So
# a value written under the old (text) value-mode must migrate to the content
# attribute when the type changes into a default-mode type — and this must happen
# whether the type is changed via the `type` IDL setter OR `setAttribute('type')`.
#
# Glimmer/Ember set the `value` PROPERTY first, then the `type` ATTRIBUTE, so the
# setAttribute path is the one real frameworks exercise (Discourse form-kit's
# `<input type=radio value={{@value}}>` rendered radios with no value attribute,
# breaking every `[value='…']` selector, until the migration ran from setAttribute).
RSpec.describe 'input type-change value migration' do
  let(:app) {
    ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
  }
  let(:session) { Capybara::Session.new(:simulated, app) }
  before { session.visit '/' }

  def probe(steps)
    session.evaluate_script(<<~JS)
      (function () {
        const i = document.createElement('input');
        #{steps}
        document.body.appendChild(i);
        return { attr: i.getAttribute('value'), idl: i.value, sel: i.matches("[value='picked']") };
      })()
    JS
  end

  it 'migrates a value set before setAttribute(type=radio) to the content attribute' do
    # Glimmer's order: set the value property, THEN the type attribute.
    expect(probe("i.value = 'picked'; i.setAttribute('type', 'radio');"))
      .to eq('attr' => 'picked', 'idl' => 'picked', 'sel' => true)
  end

  it 'migrates a value set before the type IDL setter' do
    expect(probe("i.value = 'picked'; i.type = 'radio';"))
      .to eq('attr' => 'picked', 'idl' => 'picked', 'sel' => true)
  end

  it 'keeps a value set after the type is already radio' do
    expect(probe("i.setAttribute('type', 'radio'); i.value = 'picked';"))
      .to eq('attr' => 'picked', 'idl' => 'picked', 'sel' => true)
  end

  it 'drops a non-numeric value when changed to type=number' do
    # text "abc" → number re-sanitizes the live value to "".
    result = session.evaluate_script(<<~JS)
      (function () {
        const i = document.createElement('input');
        i.value = 'abc';
        i.setAttribute('type', 'number');
        return i.value;
      })()
    JS
    expect(result).to eq('')
  end
end
