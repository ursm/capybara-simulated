# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A frame's `parent` and `top`, read from the window that is both, is that window itself (HTML §7.2.2: one WindowProxy
# per browsing context), whichever origin the frame is of: a same-origin frame's answered the frame realm's own proxy
# of it, which is no object of the page's — `frames[0].parent === window` was false.
RSpec.describe 'a frame window proxy' do
  it 'answers this window itself for its parent and top, of either origin' do
    app = ->(env) {
      if env['PATH_INFO'] == '/f'
        [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><meta charset=utf-8><p>f']]
      else
        [200, {'content-type' => 'text/html'}, [<<~HTML]]
          <!DOCTYPE html><meta charset=utf-8>
          <iframe src="/f"></iframe><iframe src="http://other.test/f"></iframe>
        HTML
      end
    }
    s = simulated_session(app)
    s.visit '/'
    got = s.evaluate_script(<<~JS)
      [0, 1].map((i) => [frames[i].parent === window, frames[i].top === window, frames[i].window === frames[i]])
    JS
    expect(got).to eq([[true, true, true], [true, true, true]])
  end
end
