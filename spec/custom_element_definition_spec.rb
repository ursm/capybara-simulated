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

  # An upgrade's constructor that removes its own frame: the reactions its upgrade enqueued are its upgrade's, never run
  # under the constructor (the frame's realm going ran its backup element queue there), and its definition's realm is
  # gone by the time they would — none runs. Chrome: `ctor 1`, `after removing`, nothing more.
  it 'runs no reaction of an element under its own upgrade constructor, which removes its frame' do
    frame = <<~HTML
      <!doctype html><meta charset=utf-8><body><x-g t=1></x-g><script>
        const P = parent;
        window.defineG = () => customElements.define('x-g', class extends HTMLElement {
          constructor() { super(); P.__log.push('ctor ' + this.getAttribute('t')); P.document.getElementById('fr').remove(); P.__log.push('after removing'); }
          connectedCallback() { P.__log.push('connected'); }
        });
      </script>
    HTML
    s = session_for('/' => '<!doctype html><meta charset=utf-8><body><iframe id=fr src="/frame"></iframe>', '/frame' => frame)
    s.within_frame('fr') { s.has_css?('x-g') }
    s.execute_script("window.__log = []; document.getElementById('fr').contentWindow.defineG();")
    expect(s.evaluate_script('__log')).to eq(['ctor 1', 'after removing'])
  end

  # Web IDL "check if we can run script": a callback whose realm's document is no longer fully active runs nothing — a
  # frame's definition's disconnectedCallback still queued when an earlier reaction of the same run removed the frame,
  # and its callbacks later. Chrome and Firefox: no `disconnected`, `connected` nor `attribute` after the removal.
  it "runs no callback of a frame's definition once an earlier reaction removed the frame" do
    s = session_for(
      '/' => '<!doctype html><meta charset=utf-8><body><div id=w></div><iframe id=fr src="/frame"></iframe>',
      '/frame' => '<!doctype html><meta charset=utf-8><body>'
    )
    s.within_frame('fr') { s.has_css?('body') }
    got = s.evaluate_script(<<~JS)
      (() => {
        const log = [];
        const fr = document.getElementById('fr');
        fr.contentWindow.__log = log;
        fr.contentWindow.eval(`customElements.define('x-q', class extends HTMLElement {
          static observedAttributes = ['a'];
          connectedCallback() { __log.push('connected'); }
          disconnectedCallback() { __log.push('disconnected'); }
          attributeChangedCallback() { __log.push('attribute'); }
        })`);
        customElements.define('x-remover', class extends HTMLElement { disconnectedCallback() { fr.remove(); log.push('removed'); } });
        const w = document.getElementById('w');
        w.append(document.createElement('x-remover'));
        const q = fr.contentDocument.createElement('x-q');
        w.append(q);
        w.innerHTML = '';
        w.append(q);
        q.setAttribute('a', '1');
        return log;
      })()
    JS
    expect(got).to eq(%w[connected removed])
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
