require 'capybara/simulated'
require_relative 'support/session_teardown'

# Capybara's scroll of an element is a real driver's `element.scrollTo()` (CSSOM View `scroll()`): the root element's
# moves the viewport, and so does the body's in quirks mode, where it is the scrolling element; in standards mode the
# body's moves the body alone — one that is no scroll container, nothing — and the root's in quirks mode moves nothing,
# which is why Capybara's page-level `scroll_to` takes `quirks: true` to aim at the body. Chrome 155, a 3000px page in
# standards mode: `document.body.scrollTo(0, 100)` leaves `scrollY` 0, `documentElement.scrollTo(0, 100)` makes it 100;
# in quirks mode `documentElement.scrollTo(0, 500)` leaves it 0.
RSpec.describe 'a driver scroll of the root and the body' do
  def session_for(doctype)
    page = "#{doctype}<meta charset=utf-8><body style=\"margin:0\"><div style=\"height:3000px\">tall</div>"
    simulated_session(->(_env) { [200, {'content-type' => 'text/html'}, [page]] }).tap {|s| s.visit '/' }
  end

  it 'moves the body alone in standards mode' do
    s = session_for('<!DOCTYPE html>')
    s.find('body').scroll_to(0, 100)
    expect(s.evaluate_script('scrollY')).to eq(0)
    s.find(:xpath, '/html').scroll_to(0, 100)
    expect(s.evaluate_script('scrollY')).to eq(100)
    s.scroll_to(0, 200)
    expect(s.evaluate_script('scrollY')).to eq(200)
  end

  it 'moves the viewport by the body in quirks mode, and nothing by the root' do
    s = session_for('')
    s.find('body').scroll_to(0, 100)
    expect(s.evaluate_script('scrollY')).to eq(100)
    s.find(:xpath, '/html').scroll_to(0, 400)
    s.scroll_to(:bottom)
    expect(s.evaluate_script('scrollY')).to eq(100)
    s.scroll_to(0, 300, quirks: true)
    expect(s.evaluate_script('scrollY')).to eq(300)
  end
end
