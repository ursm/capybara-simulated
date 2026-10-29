# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# A hyperlink is followed by its node document — whichever realm's script made it and clicked it (HTML "follow the
# hyperlink": the subject's node document's navigable): a link the page made and moved into a frame's document moves the
# frame to its fragment (`hashchange` there), the page staying where it is (Chrome).
RSpec.describe 'a link the page moved into a frame' do
  include PollUntil

  it "is followed by the frame's document" do
    session = simulated_session(lambda {|env|
      body = env['PATH_INFO'] == '/inner' ? '<p id=x>x</p>' : '<iframe src=/inner></iframe>'
      [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=utf-8><body>#{body}"]]
    })
    session.visit '/'
    poll_until { session.evaluate_script("frames[0].document.getElementById('x') !== null") }
    session.execute_script(<<~JS)
      frames[0].addEventListener('hashchange', () => { frames[0].document.title = 'moved'; });
      const a = document.createElement('a');
      a.href = '#x';
      frames[0].document.body.append(a);
      a.click();
    JS
    expect(poll_until { session.evaluate_script('frames[0].document.title') == 'moved' && session.evaluate_script('[frames[0].location.hash, location.hash]') }).to eq(['#x', ''])
  end
end
