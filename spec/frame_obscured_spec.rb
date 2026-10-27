# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# A click at an element in a frame lands in the frame's document's viewport — its container's CONTENT box, past the
# frame's border and padding — so whether its container's document lets it through is asked at that point there.
RSpec.describe 'obscured? in a frame' do
  it "asks the container's document at the point past the frame's border" do
    pages = {
      '/' => '<style>body{margin:0}</style>' \
             '<iframe id=f src="/f" style="position:absolute;top:150px;left:0;width:300px;height:100px;border:10px solid"></iframe>' \
             '<div style="position:absolute;top:150px;left:305px;width:100px;height:120px;background:red"></div>',
      '/f' => '<style>body{margin:0}</style>' \
              '<div id=far style="position:absolute;left:290px;top:80px;width:10px;height:10px">x</div>' \
              '<div id=near style="width:100px;height:20px">in</div>'
    }
    app = ->(env) { [200, {'content-type' => 'text/html'}, ["<!DOCTYPE html><meta charset=\"utf-8\"><body>#{pages.fetch(env['PATH_INFO'], '')}"]] }
    s = simulated_session(app)
    s.visit '/'
    expect(s.within_frame('f') { [s.find('#far').obscured?, s.find('#near').obscured?] }).to eq([true, false])
  end
end
