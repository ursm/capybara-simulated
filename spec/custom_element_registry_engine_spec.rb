# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The custom element registries are the engine's (ce_reactions.rs): what a registry names by, which element a definition
# is for, and which registry a node has. These hold the edges of that against headless Chrome.
RSpec.describe 'custom element registries in the engine' do
  def session_for(pages)
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]] })
    s.visit '/'
    s
  end

  # A definition goes with the realm that made it: an element of a frame's definition, adopted out of the frame, is
  # called back by no callback of it once the frame navigated away (Web IDL "check if we can run script": its realm's
  # document is not fully active). Chrome: nothing after the frame navigates.
  it "runs no callback of a definition whose realm's page was left" do
    frame = <<~HTML
      <!doctype html><meta charset=utf-8><body><script>
        customElements.define('x-f', class extends HTMLElement {
          static observedAttributes = ['a'];
          connectedCallback() { parent.__log.push('connected'); }
          disconnectedCallback() { parent.__log.push('disconnected'); }
          attributeChangedCallback(n, o, v) { parent.__log.push('attr ' + v); }
        });
      </script>
    HTML
    main = <<~HTML
      <!doctype html><meta charset=utf-8><body><iframe id=fr src="/frame"></iframe><script>
        window.__log = [];
        onload = () => {
          const fr = document.getElementById('fr'), fd = fr.contentDocument;
          window.__e = fd.createElement('x-f');
          fd.body.append(__e);
          document.body.append(__e);
          __log.length = 0;
          fr.src = '/other';
        };
      </script>
    HTML
    s = session_for('/' => main, '/frame' => frame, '/other' => '<!doctype html><body>other')
    s.within_frame('fr') { s.has_text?('other') }
    got = s.evaluate_script("(() => { __e.setAttribute('a', '2'); __e.remove(); document.body.append(__e); return __log; })()")
    expect(got).to eq([])
  end

  # A name with a lone surrogate is its code units, not the U+FFFD a string makes of it: a definition named with the
  # replacement character is for neither. Chrome: [false, false, false].
  it 'keys a definition by the code units of its name' do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    got = s.evaluate_script(<<~JS)
      (() => {
        class A extends HTMLElement {}
        customElements.define('x-\\uFFFD', A);
        class B extends HTMLParagraphElement {}
        customElements.define('y-\\uFFFD', B, { extends: 'p' });
        return [
          document.createElement('x-\\uD800') instanceof A,
          customElements.get('x-\\uD800') === A,
          document.createElement('p', { is: 'y-\\uD800' }) instanceof B
        ];
      })()
    JS
    expect(got).to eq([false, false, false])
  end

  # A shadow root's node document is its host's, so with no registry set it has that document's window registry: none
  # for a host in a document without a browsing context. Chrome: [null, null].
  it "gives a shadow root its host's document's registry" do
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body>')
    got = s.evaluate_script(<<~JS)
      (() => {
        const host = document.implementation.createHTMLDocument('').createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        return [host.customElementRegistry, root.customElementRegistry];
      })()
    JS
    expect(got).to eq([nil, nil])
  end
end
