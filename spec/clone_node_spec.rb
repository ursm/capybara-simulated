# frozen_string_literal: true

require 'capybara/simulated'
require 'rack'
require_relative 'support/session_teardown'

# DOM "clone a node": what a copy of an element carries — its attributes, exactly, and the state the cloning steps copy
# (cloning.rs). Every expectation is Chrome's.
RSpec.describe 'cloneNode' do
  it "carries an element's attributes and the state its cloning steps copy" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><body><div id=r><input id=t value=a><input id=c type=checkbox checked><svg><a xlink:href="#x"></a></svg><button onclick="window.clicked = (window.clicked || 0) + 1">b</button><p id=p>p</p></div><script>window.ran = (window.ran || 0) + 1</script>
    HTML
    expect(s.evaluate_script(<<~JS)).to eq(['typed', 'a', false, true, 'http://www.w3.org/1999/xlink', 'xlink', 1, 1, 3, 0xD800])
      (() => {
        const t = document.getElementById('t'), c = document.getElementById('c');
        t.value = 'typed'; c.checked = false; c.indeterminate = true;
        document.getElementById('p').setAttribute('data-u', 'a\\uD800b');
        const r = document.getElementById('r').cloneNode(true);
        const [t2, c2] = r.querySelectorAll('input');
        const a2 = r.querySelector('a'), p2 = r.querySelector('p');
        r.querySelector('button').click();
        document.body.appendChild(document.querySelector('script').cloneNode(true));
        const u = p2.getAttribute('data-u');
        return [t2.value, t2.getAttribute('value'), c2.checked, c2.indeterminate, a2.attributes[0].namespaceURI, a2.attributes[0].prefix,
                window.clicked, window.ran, u.length, u.charCodeAt(1)];
      })()
    JS
  end

  # An image's copy loads its source as its attributes are appended — inserted or not.
  it "loads an image's copy" do
    s = simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [<<~HTML]] }).tap {|session| session.visit '/' }
      <!DOCTYPE html><body><img id=i src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
    HTML
    s.execute_script(<<~JS)
      const c = document.getElementById('i').cloneNode(true);
      c.onload = () => { window.R = ['load', c.naturalWidth, c.complete]; };
    JS
    expect(s.evaluate_script('window.R')).to eq(['load', 1, true])
  end
end
