# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'

# CSSOM "serialize a simple selector" for type / universal selectors with namespaces:
# an any-namespace `*|` prefix drops without a default @namespace, a named prefix that
# resolves to the default namespace's URL drops, and an unprefixed universal `*` is
# omitted when another simple selector shares its compound.
RSpec.describe 'CSSOM namespaced type-selector serialization' do
  let(:app) {
    Rack::Builder.new {
      run ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><html><head><style id="t"></style></head><body></body></html>']] }
    }.to_app
  }

  before { Capybara.app = app }

  # Build a sheet whose LAST rule is `<selector> { color: red }` and return its serialized
  # selectorText. `prelude` supplies the @namespace context.
  def serialize(session, selector, prelude = '')
    session.evaluate_script(<<~JS)
      const el = document.getElementById('t');
      el.textContent = #{(prelude + selector + ' { color: red }').inspect};
      const sheet = el.sheet;
      sheet.cssRules[sheet.cssRules.length - 1].selectorText;
    JS
  end

  it 'drops an any-namespace `*|` prefix only without a default namespace' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    ns  = '@namespace ns url(ns);'
    dfl = '@namespace url(default_ns); @namespace nsdefault url(default_ns); @namespace ns url(ns);'
    expect(serialize(session, '*|e', ns)).to eq('e')      # no default → drop `*|`
    expect(serialize(session, '*|e', dfl)).to eq('*|e')   # default present → keep `*|`
    expect(serialize(session, '*|*', ns)).to eq('*')
    expect(serialize(session, '*|*', dfl)).to eq('*|*')
    expect(serialize(session, 'ns|e', ns)).to eq('ns|e')  # non-default named prefix → keep
    expect(serialize(session, '|e', ns)).to eq('|e')      # explicit null namespace → keep
    expect(serialize(session, 'e', dfl)).to eq('e')       # unprefixed → bare
  end

  it 'drops a named prefix that resolves to the default namespace URL' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    # `nsdefault` maps to the SAME url as the (prefix-less) default namespace.
    dfl = '@namespace url(default_ns); @namespace nsdefault url(default_ns); @namespace ns url(ns);'
    expect(serialize(session, 'nsdefault|e', dfl)).to eq('e')
    expect(serialize(session, 'nsdefault|*', dfl)).to eq('*')
    expect(serialize(session, 'nsdefault|e.c', dfl)).to eq('e.c')
  end

  it 'omits an unprefixed universal `*` when its compound has other simple selectors' do
    session = Capybara::Session.new(:simulated, app)
    session.visit '/'
    expect(serialize(session, '*', '')).to eq('*')            # lone universal kept
    expect(serialize(session, '*.c', '')).to eq('.c')
    expect(serialize(session, '*#i', '')).to eq('#i')
    expect(serialize(session, '*::before', '')).to eq('::before')
    expect(serialize(session, '*[attr]', '')).to eq('[attr]')
    expect(serialize(session, '* .c', '')).to eq('* .c')      # separate compound → kept
    expect(serialize(session, '|*.c', '')).to eq('|*.c')      # null-ns universal → kept
  end
end
