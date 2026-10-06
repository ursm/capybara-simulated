require 'capybara/simulated'
require_relative 'support/session_teardown'

# A request body of another realm is the body it is, to XHR as to fetch: a frame's FormData multipart, its
# URLSearchParams urlencoded, its ArrayBuffer the bytes — not the string they would convert to.
RSpec.describe 'Cross-realm request bodies' do
  let(:app) {
    lambda do |env|
      if env['REQUEST_METHOD'] == 'POST'
        type = env['CONTENT_TYPE'].to_s.split(';').first.to_s
        [200, {'content-type' => 'text/plain'}, ["#{type}|#{env['rack.input'].read.bytesize}"]]
      else
        [200, {'content-type' => 'text/html'}, ['<!doctype html><meta charset=utf-8><p>x<iframe srcdoc="y"></iframe>']]
      end
    end
  }
  let(:session) { simulated_session(app) }

  it 'sends them as their kind' do
    session.visit '/'
    got = session.evaluate_async_script(<<~JS)
      const done = arguments[0], F = frames[0];
      const send = (body) => new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', '/'); x.onload = () => r(x.responseText); x.send(body); });
      Promise.all([send(new F.FormData()), send(new F.URLSearchParams('q=1')), send(new F.ArrayBuffer(2))])
        .then((rs) => done(rs.map((r) => r.split('|')[0]).concat(rs[2].split('|')[1])));
    JS
    expect(got).to eq(['multipart/form-data', 'application/x-www-form-urlencoded', '', '2'])
  end
end
