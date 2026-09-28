# frozen_string_literal: true

require 'capybara/simulated'
require_relative 'support/session_teardown'

# The document's focused and hovered elements are internal state, not properties a page can name: an `<img name>` is a
# named property of the document (HTML §3.1.6), and one named after the slot the focus lives in answered for it — before
# the first focus, `document.activeElement` was the IMG. It is the body, as in any browser.
RSpec.describe 'document focus state' do
  it 'is not answered by a named element' do
    app = ->(_env) { [200, {'content-type' => 'text/html'}, ['<!DOCTYPE html><body><img name="_activeElement"><img name="_hoverElement">']] }
    s = simulated_session(app)
    s.visit '/'
    expect(s.evaluate_script('document.activeElement.tagName')).to eq('BODY')
    expect(s.evaluate_script('document.querySelectorAll(":hover").length')).to eq(0)
  end
end
