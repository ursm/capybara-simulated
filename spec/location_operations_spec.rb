# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# Location's operations are IDL operations: each checks its `this` is a Location and counts its arguments. Called on
# anything else, `assign` had navigated the page to `undefined` — which is how idlharness's "calling an operation on
# the wrong `this` must throw" check took html/dom/idlharness.https.html off its own page. Each expectation is Chrome's
# (154.0.8037.92).
RSpec.describe 'Location operations' do
  let(:session) { simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><body>']] }) }

  before { session.visit '/start' }

  it "refuses a `this` that is no Location, and stays where it is" do
    got = session.evaluate_script(<<~JS)
      (() => {
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.constructor.name + ': ' + e.message; } };
        return [
          thrown(() => location.assign.call({}, 'x')),
          thrown(() => location.replace.call(5, 'x')),
          thrown(() => location.reload.call({})),
          thrown(() => location.assign())
        ];
      })()
    JS
    expect(got).to eq([
      'TypeError: Illegal invocation',
      'TypeError: Illegal invocation',
      'TypeError: Illegal invocation',
      "TypeError: Failed to execute 'assign' on 'Location': 1 argument required, but only 0 present."
    ])
    expect(session.evaluate_script('location.pathname')).to eq('/start')
  end

  # (…another realm's Location navigates its own browsing context, whoever's operation is called on it)
  it "navigates the browsing context of the Location it is called on" do
    session.execute_script(<<~JS)
      const f = document.body.appendChild(document.createElement('iframe'));
      f.src = '/frame';
    JS
    got = session.evaluate_script(<<~JS)
      (() => {
        const frame = document.querySelector('iframe').contentWindow;
        location.assign.call(frame.location, frame.location.href + '#in-frame');
        frame.location.assign.call(location, location.href + '#in-page');
        return [location.hash, frame.location.hash];
      })()
    JS
    expect(got).to eq(['#in-page', '#in-frame'])
  end

  it 'gives each operation the length of its required arguments, and still navigates' do
    expect(session.evaluate_script('[location.assign.length, location.replace.length, location.reload.length]')).to eq([1, 1, 0])
    session.execute_script("location.assign('#zz')")
    expect(session.evaluate_script('location.hash')).to eq('#zz')
  end

  # HTML §7.2.4: every member an own, unforgeable property; valueOf and @@toPrimitive own and fixed; the protocol
  # setter's scheme checked; an empty hash a URL ending in `#` (Chrome 154, measured).
  it 'is the interface HTML describes' do
    got = session.evaluate_script(<<~JS)
      (() => {
        const own = Object.getOwnPropertyDescriptor(location, 'assign');
        const thrown = (f) => { try { f(); return 'no'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          typeof Location, location instanceof Location, Object.getOwnPropertyNames(Location.prototype),
          [own.writable, own.enumerable, own.configurable], location.valueOf === Object.prototype.valueOf,
          String(location.ancestorOrigins), location.ancestorOrigins === location.ancestorOrigins,
          thrown(() => { location.protocol = '1x'; }), thrown(() => new Location())
        ];
      })()
    JS
    expect(got).to eq([
      'function', true, ['constructor'], [false, true, false], true, '[object DOMStringList]', true,
      "SyntaxError: Failed to set the 'protocol' property on 'Location': '1x' is an invalid protocol.",
      "TypeError: Failed to construct 'Location': Illegal constructor"
    ])
    session.execute_script("location.hash = 'a'")
    session.execute_script("location.hash = ''")
    expect(session.evaluate_script('location.href')).to end_with('/start#')
  end

  # One ancestor origin per ancestor; `hash = ''` on a URL with no fragment none; a traversal between fragments a
  # `hashchange`; `javascript:` run; a `replace` no history entry; a URL with a `%` that begins no escape sent as written
  # (Chrome 154 and the spec).
  it 'navigates as HTML has a location navigate' do
    session.execute_script(<<~JS)
      document.body.appendChild(document.createElement('iframe')).src = '/b/f';
    JS
    expect(session.evaluate_script('[frames[0].location.ancestorOrigins.length, location.ancestorOrigins.length]')).to eq([1, 0])
    session.execute_script("location.hash = ''")
    expect(session.evaluate_script('location.href')).to end_with('/start')
    session.execute_script(<<~JS)
      window.seen = [];
      addEventListener('hashchange', (e) => seen.push(e.newURL.split('#')[1]));
      location.hash = 'q';
    JS
    session.execute_script("location.hash = 'r'")
    session.execute_script('history.back()')
    session.execute_script("location.href = 'javascript:seen.push(\"js\")'")
    expect(session.evaluate_script('seen')).to eq(%w[q r q js])
    length = session.evaluate_script('history.length')
    session.execute_script("location.replace('/other?a=%zz')")
    expect(session.evaluate_script('[history.length, location.pathname, location.search]')).to eq([length, '/other', '?a=%zz'])
  end
end
