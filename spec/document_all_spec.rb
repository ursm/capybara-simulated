# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# `document.all` (HTML §2.6.2): an HTMLAllCollection that is HTML's [[IsHTMLDDA]] object — typeof "undefined", falsy,
# == null, so `if (document.all)` takes the path a library takes in a modern browser — yet a live collection of the
# document's elements in tree order, its indices and its all-named elements (an id, or the name of an `a`, `img`, `form`,
# …: one an element, more an HTMLCollection), and callable as its `item`.
RSpec.describe 'document.all' do
  let(:page) { '<!DOCTYPE html><p id="a">x</p><img name="b"><img name="b"><form name="f"></form><span name="s"></span>' }
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }) }

  it 'is an undetectable live collection of the document’s elements' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      [typeof document.all, !!document.all, document.all == null, document.all === document.all,
       document.all.length === document.getElementsByTagName('*').length, document.all[0].localName,
       String(document.all), document.all instanceof HTMLAllCollection]
    JS
    expect(got).to eq(['undefined', false, true, true, true, 'html', '[object HTMLAllCollection]', true])
    session.execute_script("document.body.append(document.createElement('i'))")
    expect(session.evaluate_script("document.all[document.all.length - 1].localName")).to eq('i')
  end

  it 'finds its all-named elements, by its members and by a call' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      [document.all.a.id, String(document.all.b), document.all.b.length, document.all('f').localName, document.all.item('a').id,
       document.all.s, document.all(), document.all.namedItem('zz'), document.all('1').localName]
    JS
    expect(got).to eq(['a', '[object HTMLCollection]', 2, 'form', 'a', nil, nil, nil, 'head'])
  end

  # …as a legacy platform object's (Web IDL §3.9): its names its own keys though unenumerable, neither deleted nor
  # defined, none masking an own property; a name's collection live as names are written, one per name (Chrome,
  # Firefox); a Symbol no name its call takes; and a script's answer its elements, as WebDriver's clone has it.
  it 'is a legacy platform object of named properties' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const all = document.all, b = all.b, before = b.length;
        document.images[0].name = 'zz';
        Reflect.defineProperty(all, 'expando', {value: 5});
        document.body.append(Object.assign(document.createElement('i'), {id: 'expando'}));
        let symbol;
        try { all(Symbol()); } catch (e) { symbol = e.name; }
        const index = (n) => /^\\d+$/.test(n), names = Object.getOwnPropertyNames(all).filter((n) => !index(n)).sort();
        return [before, b.length, names, Object.keys(all).every(index), Reflect.deleteProperty(all, 'a'),
                Reflect.defineProperty(all, 'a', {value: 1}), all.expando, symbol];
      })()
    JS
    expect(got).to eq([2, 1, %w[a b expando f zz], true, false, false, 5, 'TypeError'])
    expect(session.evaluate_script('document.all').map(&:tag_name).first(3)).to eq(%w[html head body])
  end

  # …and no null to a binding: an argument of a nullable type `document.all` is an object of the wrong interface
  # (Web IDL asks for null or undefined, which `== null` would take it for: Chrome, Firefox — TypeError)
  it 'is no null to a nullable argument' do
    session.visit '/'
    got = session.evaluate_script(<<~JS)
      (() => {
        const el = document.createElement('i');
        try { document.body.insertBefore(el, document.all); return 'inserted'; } catch (e) { return e.name; }
      })()
    JS
    expect(got).to eq('TypeError')
  end

  # …and an object to every binding that asks for one (Web IDL's "Type(V) is Object", which its typeof "undefined" does
  # not tell): a dictionary's members read off it, a dictionary-or-boolean union's dictionary, a sequence of its
  # elements, a callback function as callable, an event handler kept (Chrome)
  it 'is an object to a dictionary, a sequence, a callback and an event handler' do
    page = '<!DOCTYPE html><div id="capture"></div><div id="bubbles"></div><p id="p"><i id="c">x</i></p>'
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] })
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      (() => {
        const order = [], p = document.getElementById('p'), c = document.getElementById('c');
        p.addEventListener('zz', () => order.push('p'), document.all);
        c.addEventListener('zz', () => order.push('c'));
        c.dispatchEvent(new Event('zz', {bubbles: true}));
        const el = document.createElement('b');
        el.onclick = document.all;
        return [order.join(), new Event('x', document.all).bubbles, new Blob(document.all).size > 0,
                typeof requestAnimationFrame(document.all), el.onclick === document.all];
      })()
    JS
    expect(got).to eq(['p,c', true, true, 'number', true])
  end

  # …and a callable one wherever a callback is called: a listener, a timer's handler, an iterable's forEach, an
  # observer's callback, a custom element reaction — by [[Call]], as it has no `call` of its own (Chrome)
  it 'is called as a callback' do
    session.visit '/'
    session.execute_script(<<~JS)
      window.errors = [];
      onerror = (m) => { errors.push(m); };
      document.body.addEventListener('zz', document.all);
      document.body.dispatchEvent(new Event('zz'));
      setTimeout(document.all);
      new Headers([['a', 'b']]).forEach(document.all);
      new URLSearchParams('a=b').forEach(document.all);
      new MutationObserver(document.all).observe(document.body, {childList: true});
      customElements.define('x-all', class extends HTMLElement {}, {});
      const C = class extends HTMLElement {};
      C.prototype.connectedCallback = document.all;
      customElements.define('x-called', C);
      document.body.append(document.createElement('x-called'));
    JS
    expect(session.evaluate_script('errors')).to eq([])
  end

  # …and a frame's live collections — its `all`'s names among them — follow an id or a class written through another
  # realm's wrapper of its node, as through its own.
  it 'follows a write another realm makes to a frame’s node' do
    frame = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [env['PATH_INFO'] == '/f' ? '<!DOCTYPE html>f' : '<!DOCTYPE html><iframe src="/f"></iframe>']] })
    frame.visit '/'
    got = frame.evaluate_script(<<~JS)
      (() => {
        const d = frames[0].document, b = Object.assign(document.createElement('b'), {className: 'k', id: 'x'});
        d.body.append(b);
        const byClass = d.getElementsByClassName('k'), before = [byClass.length, d.all.x === b];
        Object.assign(b, {className: '', id: ''});
        return [before, byClass.length, d.all.x ?? null];
      })()
    JS
    expect(got).to eq([[1, true], 0, nil])
  end
end
