# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A hyperlink followed in a document that is not fully active — its frame removed, its realm's code still running —
# navigates nothing (HTML "follow the hyperlink" step 1: an `<a>` that "cannot navigate"): not the top page, which a
# discarded realm's lookup of its own id took it for.
RSpec.describe 'a hyperlink in a discarded frame' do
  it 'navigates nothing' do
    s = simulated_session(lambda {|env|
      body = case env['PATH_INFO']
             when '/f' then '<a id=a href="/next">x</a>'
             when '/next' then '<title>next</title>'
             else '<title>top</title><iframe src=/f></iframe>'
             end
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8>#{body}"]]
    })
    s.visit '/'
    s.execute_script(<<~JS)
      const f = document.querySelector('iframe'), d = f.contentDocument;
      f.remove();
      d.getElementById('a').click();
    JS
    expect([s.title, URI(s.current_url).path]).to eq(['top', '/'])
  end
end
