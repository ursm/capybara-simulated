# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/garbage'

# define() is the engine's (ce_reactions.rs `ceDefineCheck`, `ceDefine`): what refuses a definition, the definition's
# record and what finds it — by name, by local name and is value, by constructor — and its upgrade candidates, given
# upgrade reactions: the window registry's in its realm's document, a scoped registry's in each document of its scoped
# document set, in the order they were associated with it (HTML define() step 18, DOM "insert" step 7.7).
RSpec.describe 'a custom element definition' do
  def session_for(pages)
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    s
  end

  # The engine holds a definition's object weakly, its registry strongly: one whose class nothing else holds outlives a
  # collection, and still makes and calls back elements.
  it 'lives with its registry, whatever else holds its class' do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    s.execute_script(<<~JS)
      window.__log = [];
      customElements.define('x-kept', class extends HTMLElement { connectedCallback() { __log.push('connected'); } });
    JS
    collect_garbage(s)
    got = s.evaluate_script(<<~JS)
      (() => {
        const ctor = customElements.get('x-kept');
        document.body.append(document.createElement('x-kept'));
        return [typeof ctor, customElements.getName(ctor), __log];
      })()
    JS
    expect(got).to eq(['function', 'x-kept', ['connected']])
  end

  # A scoped registry upgrades in every document a connected element or shadow root of it was inserted into — a frame's
  # too — not its own window's alone. Chrome: both upgraded (WPT scoped-registry-define-upgrade-criteria).
  it "upgrades a scoped registry's elements in a frame's document" do
    s = session_for(
      '/' => '<!doctype html><meta charset=utf-8><body><iframe id=fr src="/frame"></iframe>',
      '/frame' => '<!doctype html><meta charset=utf-8><body>'
    )
    s.within_frame('fr') { s.has_css?('body') }
    got = s.evaluate_script(<<~JS)
      (() => {
        const registry = new CustomElementRegistry();
        const made = [];
        const roots = [document, document.getElementById('fr').contentDocument].map((doc, i) => {
          const host = doc.createElement('div');
          const shadow = host.attachShadow({mode: 'open', customElementRegistry: registry});
          doc.body.append(host);
          shadow.innerHTML = `<x-scoped id="e${i}"></x-scoped>`;
          return shadow;
        });
        registry.define('x-scoped', class extends HTMLElement { constructor() { super(); made.push(this.id); } });
        return made;
      })()
    JS
    expect(got).to eq(%w[e0 e1])
  end

  # define() step 4: a constructor another registry defines is one this one may define too; its name is this one's.
  it "names a constructor by each registry's own definition" do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    got = s.evaluate_script(<<~JS)
      (() => {
        class Shared extends HTMLElement {}
        const scoped = new CustomElementRegistry();
        customElements.define('x-global', Shared);
        scoped.define('x-scoped', Shared);
        let again;
        try { scoped.define('x-other', Shared); } catch (e) { again = e.name; }
        return [customElements.getName(Shared), scoped.getName(Shared), again];
      })()
    JS
    expect(got).to eq(%w[x-global x-scoped NotSupportedError])
  end
end
