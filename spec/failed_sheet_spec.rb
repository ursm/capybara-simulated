# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A style sheet whose fetch fails is none (HTML "process the linked resource": a CSS style sheet is created only where
# it succeeded; CSSOM "fetch a CSS style sheet" alike): a status not ok, a type not text/css outside quirks mode — a
# `<link>`'s `.sheet` null, its `error` fired, and in no style sheet list; an `@import`'s `styleSheet` null — and,
# made none, fetched no more until it obtains another.
RSpec.describe 'a style sheet whose fetch fails' do
  let(:hits) { Hash.new(0) }
  let(:session) do
    hits = self.hits
    simulated_session(lambda {|env|
      hits[env['PATH_INFO']] += 1
      case env['PATH_INFO']
      when '/plain.css' then [200, {'content-type' => 'text/plain'}, ['p { color: red }']]
      when '/ok.css' then [200, {'content-type' => 'text/css'}, ['p { color: green }']]
      when '/x.xhtml'
        body = '<?xml version="1.0"?><?xml-stylesheet href="/404.css"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>'
        [200, {'content-type' => 'application/xhtml+xml'}, [body]]
      when '/' then [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><p>x</p>']]
      else [404, {'content-type' => 'text/css'}, ['']]
      end
    })
  end

  it "is none for a link of a type not text/css, whose error fires, and an @import's" do
    session.visit '/'
    session.execute_script(<<~JS)
      window.events = [];
      const l = Object.assign(document.createElement('link'), {rel: 'stylesheet', href: '/plain.css'});
      l.onload = l.onerror = (e) => events.push(e.type);
      document.head.append(l);
      const s = document.head.appendChild(document.createElement('style'));
      s.textContent = '@import url(/plain.css); @import url(/ok.css);';
      window.imports = () => [...s.sheet.cssRules].map((r) => (r.styleSheet ? r.styleSheet.cssRules.length : null));
    JS
    expect(session.evaluate_script('events')).to eq(['error'])
    expect(session.evaluate_script('[document.querySelector("link").sheet, document.styleSheets.length]')).to eq([nil, 1])
    expect(session.evaluate_script('imports()')).to eq([nil, 1])
  end

  it 'fetches a failed <?xml-stylesheet?> once however often it is read' do
    session.visit '/x.xhtml'
    5.times do |i|
      session.execute_script("document.body.append(document.createElement('p')); window.r#{i} = [document.firstChild.sheet, document.styleSheets.length]")
      session.evaluate_script('getComputedStyle(document.body.lastChild).color')
    end
    expect(session.evaluate_script('[r0, r4]')).to eq([[nil, 0], [nil, 0]])
    expect(hits['/404.css']).to eq(1)
  end
end
