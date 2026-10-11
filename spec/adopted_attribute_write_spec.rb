# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An element the page made and appended into a frame's document is the frame's: a write to its attributes is heard by
# the frame's style engine and runs the frame's slot steps, whichever realm's script makes it (Chrome alike).
RSpec.describe 'an attribute write to an element adopted into a frame' do
  let(:pages) {
    {
      '/' => '<!DOCTYPE html><meta charset=utf-8><body><iframe id=f src="/f"></iframe>',
      '/f' => '<!DOCTYPE html><meta charset=utf-8><style>.big{width:77px}</style><body><div id=out></div><div id=host></div>'
    }
  }
  let(:session) { simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages[env['PATH_INFO']] || '']] }) }

  def in_frame(js)
    session.visit '/'
    session.evaluate_async_script(<<~JS)
      const done = arguments[0];
      const f = document.getElementById('f');
      const go = () => { const fd = f.contentDocument, fw = f.contentWindow; #{js} };
      if (f.contentDocument && f.contentDocument.getElementById('out')) go(); else f.onload = go;
    JS
  end

  it 'restyles it in the frame' do
    got = in_frame(<<~JS)
      const b = document.createElement('div');
      fd.getElementById('out').append(b);
      const before = fw.getComputedStyle(b).width;
      b.setAttribute('class', 'big');
      done([before === '77px', fw.getComputedStyle(b).width]);
    JS
    expect(got).to eq([false, '77px'])
  end

  it 'assigns it to the slot its `slot` names' do
    got = in_frame(<<~JS)
      const host = fd.getElementById('host');
      const sr = host.attachShadow({mode: 'open'});
      sr.innerHTML = '<slot></slot><slot name=n></slot>';
      const b = document.createElement('span');
      host.append(b);
      b.slot = 'n';
      done([sr.querySelector('slot[name=n]').assignedNodes().length, sr.querySelector('slot:not([name])').assignedNodes().length]);
    JS
    expect(got).to eq([1, 0])
  end
end
