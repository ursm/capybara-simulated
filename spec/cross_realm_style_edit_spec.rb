# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A change another realm's code makes to a document's tree is the document's: a `<style>` a frame made and put in the
# page, its text edited through the frame's own methods, restyles the page — its cascade refreshed and its tree's memos
# moved, as an edit from the page's own code does (mutation.rs `record_child_list`, `note_cascade`).
RSpec.describe 'a cross-realm edit of a style sheet owner' do
  include PollUntil

  def session
    pages = {
      '/'  => '<!DOCTYPE html><meta charset="utf-8"><div id=t>x</div><iframe id=f src="/f"></iframe>',
      '/f' => '<!DOCTYPE html><meta charset="utf-8"><div id=t>y</div>'
    }
    s = simulated_session(->(env) { [200, {'content-type' => 'text/html'}, [pages.fetch(env['PATH_INFO'], '')]] })
    s.visit '/'
    poll_until { s.evaluate_script('document.getElementById("f").contentDocument?.getElementById("t") != null') }
    s
  end

  it "restyles the page for a frame's style edited in it" do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq(['rgb(1, 1, 1)', 'rgb(2, 2, 2)', 'rgb(3, 3, 3)'])
      (() => {
        const fd = document.getElementById('f').contentDocument, t = document.getElementById('t');
        const st = fd.createElement('style');
        st.textContent = '#t { color: rgb(1, 1, 1) }';
        document.body.append(st);
        const out = [getComputedStyle(t).color];
        st.textContent = '#t { color: rgb(2, 2, 2) }';
        out.push(getComputedStyle(t).color);
        st.firstChild.data = '#t { color: rgb(3, 3, 3) }';
        out.push(getComputedStyle(t).color);
        return out;
      })()
    JS
  end

  it "restyles a frame for the page's style moved into it and edited there" do
    s = session
    expect(s.evaluate_script(<<~JS)).to eq(['rgb(5, 5, 5)', 'rgb(6, 6, 6)'])
      (() => {
        const fd = document.getElementById('f').contentDocument, ft = fd.getElementById('t');
        const st = document.createElement('style');
        st.textContent = '#t { color: rgb(5, 5, 5) }';
        fd.body.append(st);
        const fw = fd.defaultView, out = [fw.getComputedStyle(ft).color];
        st.firstChild.data = '#t { color: rgb(6, 6, 6) }';
        out.push(fw.getComputedStyle(ft).color);
        return out;
      })()
    JS
  end
end
