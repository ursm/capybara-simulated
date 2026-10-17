# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# An image's `width` / `height` (HTML §4.8.4.4): its content box's where it is being rendered, else its dimension
# attribute's, else its natural size. Chrome, every figure: [id, width, height].
RSpec.describe 'img width and height' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, [<<~HTML]]
        <!doctype html><meta charset="utf-8"><body>
        <img id=a width=100 height=50 style="width:30px">
        <img id=b width=100 height=50 style="display:none">
        <img id=c width=100 height=50>
        <div style="display:none"><img id=d width=70 height=20 style="width:5px"></div>
        <img id=e style="width:40px;height:10px">
        <img id=f width=100 height=50 style="width:30px;padding:5px;border:2px solid">
      HTML
    end
  }

  it "reads a rendered image's content box, and an unrendered one's attributes" do
    session = simulated_session(app)
    session.visit '/'
    got = session.evaluate_script("['a','b','c','d','e','f'].map((id) => { const i = document.getElementById(id); return [id, i.width, i.height]; })")
    expect(got).to eq([['a', 30, 50], ['b', 100, 50], ['c', 100, 50], ['d', 70, 20], ['e', 40, 10], ['f', 30, 50]])
    expect(session.find('#a')[:width]).to eq(30)
  end
end
