require 'capybara/simulated'
require_relative 'support/session_teardown'

# navigator.geolocation: spec-compliant Geolocation API whose position is
# injectable from tests via `page.driver.set_geolocation(...)`. Callbacks are
# delivered asynchronously on the virtual clock, so each assertion reads back a
# global the callback set, after a follow-up `evaluate_script` drains settle.
RSpec.describe 'navigator.geolocation' do
  let(:app) {
    lambda do |_env|
      [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']]
    end
  }
  let(:session) { simulated_session(app) }

  before { session.visit '/' }

  it "exposes 'geolocation' on navigator" do
    expect(session.evaluate_script("'geolocation' in navigator")).to be(true)
    expect(session.evaluate_script('typeof navigator.geolocation.getCurrentPosition')).to eq('function')
    expect(session.evaluate_script('typeof navigator.geolocation.watchPosition')).to eq('function')
    expect(session.evaluate_script('typeof navigator.geolocation.clearWatch')).to eq('function')
  end

  it 'getCurrentPosition delivers configured coords asynchronously' do
    session.driver.set_geolocation(latitude: 35.6812, longitude: 139.7671, accuracy: 5)

    session.execute_script(<<~JS)
      window.__pos = null;
      window.__err = null;
      navigator.geolocation.getCurrentPosition(
        function (p) { window.__pos = {lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy}; },
        function (e) { window.__err = e.code; }
      );
    JS

    expect(session.evaluate_script('window.__err')).to be_nil
    expect(session.evaluate_script('window.__pos && window.__pos.lat')).to eq(35.6812)
    expect(session.evaluate_script('window.__pos && window.__pos.lng')).to eq(139.7671)
    expect(session.evaluate_script('window.__pos && window.__pos.acc')).to eq(5)
  end

  it 'getCurrentPosition fills coordinate defaults' do
    session.driver.set_geolocation(latitude: 1, longitude: 2)

    session.execute_script(<<~JS)
      window.__c = null;
      navigator.geolocation.getCurrentPosition(function (p) { window.__c = p.coords; });
    JS

    expect(session.evaluate_script('window.__c && window.__c.accuracy')).to eq(10)
    expect(session.evaluate_script('window.__c && window.__c.altitude')).to be_nil
    expect(session.evaluate_script('window.__c && window.__c.altitudeAccuracy')).to be_nil
    expect(session.evaluate_script('window.__c && window.__c.heading')).to be_nil
    expect(session.evaluate_script('window.__c && window.__c.speed')).to be_nil
    expect(session.evaluate_script('typeof (window.__c && window.__c.latitude)')).to eq('number')
  end

  it 'getCurrentPosition errors with POSITION_UNAVAILABLE when nothing configured' do
    session.execute_script(<<~JS)
      window.__pos = null;
      window.__err = null;
      navigator.geolocation.getCurrentPosition(
        function (p) { window.__pos = p; },
        function (e) { window.__err = {code: e.code, unavail: e.POSITION_UNAVAILABLE}; }
      );
    JS

    expect(session.evaluate_script('window.__pos')).to be_nil
    expect(session.evaluate_script('window.__err && window.__err.code')).to eq(2)
    expect(session.evaluate_script('window.__err && window.__err.unavail')).to eq(2)
  end

  it 'getCurrentPosition errors with PERMISSION_DENIED when denied' do
    session.driver.set_geolocation(denied: true)

    session.execute_script(<<~JS)
      window.__err = null;
      navigator.geolocation.getCurrentPosition(
        function () {},
        function (e) { window.__err = {code: e.code, denied: e.PERMISSION_DENIED}; }
      );
    JS

    expect(session.evaluate_script('window.__err && window.__err.code')).to eq(1)
    expect(session.evaluate_script('window.__err && window.__err.denied')).to eq(1)
  end

  it 'exposes GeolocationPositionError constants on the error object' do
    session.execute_script(<<~JS)
      window.__consts = null;
      navigator.geolocation.getCurrentPosition(
        function () {},
        function (e) { window.__consts = {p: e.PERMISSION_DENIED, u: e.POSITION_UNAVAILABLE, t: e.TIMEOUT}; }
      );
    JS

    expect(session.evaluate_script('window.__consts && window.__consts.p')).to eq(1)
    expect(session.evaluate_script('window.__consts && window.__consts.u')).to eq(2)
    expect(session.evaluate_script('window.__consts && window.__consts.t')).to eq(3)
  end

  it 'watchPosition delivers, re-delivers on update, then clearWatch stops it' do
    session.driver.set_geolocation(latitude: 10, longitude: 20)

    session.execute_script(<<~JS)
      window.__count = 0;
      window.__last = null;
      window.__watchId = navigator.geolocation.watchPosition(function (p) {
        window.__count += 1;
        window.__last = p.coords.latitude;
      });
    JS

    expect(session.evaluate_script('window.__watchId')).to be >= 1
    expect(session.evaluate_script('window.__count')).to eq(1)
    expect(session.evaluate_script('window.__last')).to eq(10)

    # Updating the position re-delivers to the active watch.
    session.driver.set_geolocation(latitude: 30, longitude: 40)

    expect(session.evaluate_script('window.__count')).to eq(2)
    expect(session.evaluate_script('window.__last')).to eq(30)

    # After clearWatch, further position updates no longer deliver.
    session.execute_script('navigator.geolocation.clearWatch(window.__watchId);')
    session.driver.set_geolocation(latitude: 50, longitude: 60)

    expect(session.evaluate_script('window.__count')).to eq(2)
    expect(session.evaluate_script('window.__last')).to eq(30)
  end

  it 'permissions.query reflects the configured geolocation state' do
    query = <<~JS
      var done = arguments[0];
      navigator.permissions.query({name: 'geolocation'}).then(function (r) { done(r.state); });
    JS

    expect(session.evaluate_async_script(query)).to eq('prompt')

    session.driver.set_geolocation(latitude: 1, longitude: 2)
    expect(session.evaluate_async_script(query)).to eq('granted')

    session.driver.set_geolocation(denied: true)
    expect(session.evaluate_async_script(query)).to eq('denied')
  end
end
