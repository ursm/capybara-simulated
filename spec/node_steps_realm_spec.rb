# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A node's own steps are functions, run by the realm of whatever code calls them (dom-nodes.js) — where its members
# were its prototype's, run by its own. The steps that act in a document's realm — its window, its selection, its focus
# chain, its images and named properties — go to the realm whose arena the document is in (`REALM`), as they went
# with the prototype: a frame's autofocus candidate, flushed by the top-level document, is focused by the frame's realm,
# and an image adopted into the page by a parent a frame made is the page's to load.
RSpec.describe "a node's steps, by its document's realm" do
  png = ['89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082'].pack('H*')
  let(:pages) {
    {
      '/' => '<!DOCTYPE html><meta charset=utf-8><body><pre id=out></pre><iframe id=fr src="/f"></iframe>',
      '/f' => '<!DOCTYPE html><meta charset=utf-8><body>frame',
      '/af' => '<!DOCTYPE html><meta charset=utf-8><body><pre id=out></pre><iframe src="/af-frame"></iframe>',
      '/af-frame' => <<~'HTML'
        <!DOCTYPE html><meta charset=utf-8><body><input id=i autofocus onfocus="parent.document.getElementById('out').textContent = JSON.stringify([event.view === window, event instanceof FocusEvent, document.activeElement.id, document.hasFocus()])">
      HTML
    }
  }
  let(:session) {
    simulated_session(lambda {|env|
      next [200, {'content-type' => 'image/png'}, [png]] if env['PATH_INFO'] == '/x.png'
      [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'])]]
    })
  }

  it "focuses a frame's autofocus candidate in the frame" do
    session.visit '/af'
    expect(session).to have_css('#out', text: '[')
    expect(session.evaluate_script('out.textContent')).to eq('[true,true,"i",true]')
    expect(session.evaluate_script('[document.activeElement.localName, frames[0].document.hasFocus()]')).to eq(['iframe', true])
  end

  it 'loads an image adopted into the page through a parent a frame made' do
    session.visit '/'
    expect(session.evaluate_script("document.getElementById('fr').contentDocument.body.textContent")).to eq('frame')
    session.execute_script(<<~JS)
      const div = document.getElementById('fr').contentDocument.createElement('div');
      document.body.append(div);
      const img = document.implementation.createHTMLDocument('').createElement('img');
      img.name = 'nm';
      img.onload = () => { out.textContent += 'load'; };
      img.src = '/x.png';
      div.append(img);
      out.textContent = (document.nm === img) + ';';
    JS
    expect(session).to have_css('#out', text: 'true;load')
  end
end
