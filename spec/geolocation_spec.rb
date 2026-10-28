require 'capybara/simulated'
require_relative 'support/session_teardown'
require_relative 'support/poll_until'

# navigator.geolocation and navigator.permissions (W3C Geolocation, W3C Permissions), generated from their IDL, the
# position injectable from tests via `page.driver.set_geolocation(...)`: what a request answers and the permissions'
# states are the engine's (geolocation.rs), each callback called in a task of its own — so each assertion reads back a
# global the callback set, after a follow-up `evaluate_script` drains settle. Chrome's figures measured headless.
RSpec.describe 'navigator.geolocation' do
  include PollUntil

  let(:app) {
    lambda do |env|
      next [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] unless env['PATH_INFO'] == '/w.js'

      worker = <<~JS
        navigator.permissions.query({name: 'geolocation'}).then((s) => {
          postMessage('init ' + s.state);
          s.onchange = () => postMessage('change ' + s.state);
        });
      JS
      [200, {'content-type' => 'text/javascript'}, [worker]]
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

  it 'answers with interface objects, a callback in a task after the script that asked' do
    session.driver.set_geolocation(latitude: 1, longitude: 2, accuracy: 3)
    session.execute_script(<<~JS)
      window.__seen = [];
      let sync = true;
      navigator.geolocation.getCurrentPosition(function (p) {
        window.__seen.push(sync, p instanceof GeolocationPosition, p.coords instanceof GeolocationCoordinates, p.coords === p.coords,
                           JSON.stringify(p.toJSON().coords), typeof p.timestamp);
      });
      sync = false;
      window.__shape = [navigator.geolocation instanceof Geolocation, navigator.geolocation === navigator.geolocation,
                        String(navigator.geolocation), typeof GeolocationPositionError.TIMEOUT];
      try { new Geolocation(); } catch (e) { window.__shape.push(e.name); }
    JS
    expect(session.evaluate_script('window.__shape')).to eq([true, true, '[object Geolocation]', 'number', 'TypeError'])
    expect(session.evaluate_script('window.__seen')).to eq(
      [false, true, true, true, '{"accuracy":3,"latitude":1,"longitude":2,"altitude":null,"altitudeAccuracy":null,"heading":null,"speed":null}', 'number']
    )
  end

  it 'answers the emulated position as it is now, timed then, whatever maximumAge says; with none, a timeout of 0 times out' do
    session.driver.set_geolocation(latitude: 1, longitude: 2)
    session.execute_script(<<~JS)
      window.__seen = [];
      navigator.geolocation.getCurrentPosition((p) => { window.__first = p.timestamp; window.__seen.push(p.coords.latitude); });
    JS
    expect(session.evaluate_script('window.__seen')).to eq([1])
    session.driver.set_geolocation(latitude: 3, longitude: 4)
    session.execute_script(<<~JS)
      window.__seen = [];
      const err = (e) => window.__seen.push([e.code, e.message, String(e)]);
      navigator.geolocation.getCurrentPosition((p) => window.__seen.push(p.coords.latitude, p.timestamp >= window.__first), err, {maximumAge: 60000, timeout: 0});
    JS
    expect(session.evaluate_script('window.__seen')).to eq([3, true])
    session.driver.set_geolocation
    session.execute_script(<<~JS)
      window.__seen = [];
      const err = (e) => window.__seen.push([e.code, e.message, String(e)]);
      navigator.geolocation.getCurrentPosition(() => window.__seen.push('ok'), err, {maximumAge: 60000, timeout: 0});
      navigator.geolocation.getCurrentPosition(() => window.__seen.push('ok'), err, {maximumAge: 60000});
    JS
    expect(session.evaluate_script('window.__seen')).to eq(
      [[3, 'Timeout expired', '[object GeolocationPositionError]'], [2, 'Position unavailable', '[object GeolocationPositionError]']]
    )
  end

  it "removes a watch its request is denied, and calls back a frame's watch as the page's position moves" do
    session.driver.set_geolocation(denied: true)
    session.execute_script(<<~JS)
      window.__seen = [];
      navigator.geolocation.watchPosition((p) => window.__seen.push('ok ' + p.coords.latitude), (e) => window.__seen.push('err ' + e.code));
      const f = document.body.appendChild(document.createElement('iframe'));
      window.__frame = f;
    JS
    expect(session.evaluate_script('window.__seen')).to eq(['err 1'])
    session.driver.set_geolocation(latitude: 5, longitude: 6)
    session.execute_script("__frame.contentWindow.navigator.geolocation.watchPosition((p) => parent.__seen.push('frame ' + p.coords.latitude))")
    session.driver.set_geolocation(latitude: 7, longitude: 8)
    expect(session.evaluate_script('window.__seen')).to eq(['err 1', 'frame 5', 'frame 7'])
  end

  it "rejects a detached document's query, and knows Chrome's names and what their descriptors must say" do
    session.execute_script(<<~JS)
      window.__seen = {};
      const f = document.body.appendChild(document.createElement('iframe'));
      const permissions = f.contentWindow.navigator.permissions;
      f.remove();
      const say = (k) => [(s) => window.__seen[k] = s.state, (e) => window.__seen[k] = e.name + ': ' + e.message];
      permissions.query({name: 'geolocation'}).then(...say('detached'));
      for (const d of [{name: 'keyboard-lock'}, {name: 'bluetooth'}, {name: 'push'}, {name: 'push', userVisibleOnly: true}, {name: 'nfc'},
                       {name: 'fullscreen', allowWithoutGesture: true}, {name: 'periodic-background-sync'}]) {
        navigator.permissions.query(d).then(...say(JSON.stringify(d)));
      }
    JS
    q = "Failed to execute 'query' on 'Permissions': "
    expect(session.evaluate_script('window.__seen')).to eq(
      'detached' => "InvalidStateError: #{q}The document is not active",
      '{"name":"keyboard-lock"}' => 'granted',
      '{"name":"bluetooth"}' => "TypeError: #{q}Failed to read the 'name' property from 'PermissionDescriptor': The provided value 'bluetooth' is not a valid enum value of type PermissionName.",
      '{"name":"push"}' => "NotSupportedError: #{q}Push Permission without userVisibleOnly:true isn't supported yet.",
      '{"name":"push","userVisibleOnly":true}' => 'prompt',
      '{"name":"nfc"}' => "TypeError: #{q}Web NFC is not enabled.",
      '{"name":"fullscreen","allowWithoutGesture":true}' => 'denied',
      '{"name":"periodic-background-sync"}' => 'denied'
    )
  end

  it 'hands out watch ids from 1, calls back no watch cleared before its task, and reports what a callback throws' do
    session.driver.set_geolocation(latitude: 1, longitude: 2)
    session.execute_script(<<~JS)
      window.__seen = [];
      addEventListener('error', (e) => { window.__seen.push(e.error.message); e.preventDefault(); });
      const g = navigator.geolocation;
      const a = g.watchPosition(() => { throw new Error('boom'); });
      const b = g.watchPosition(() => window.__seen.push('b'));
      const c = g.watchPosition(() => window.__seen.push('c'));
      g.clearWatch(c);
      window.__seen.push(a, b, c);
    JS
    expect(session.evaluate_script('window.__seen')).to eq([1, 2, 3, 'boom', 'b'])
  end

  it 'rejects a descriptor that names no powerful feature, and tells a PermissionStatus its state moved' do
    session.execute_script(<<~JS)
      window.__seen = [];
      const p = navigator.permissions;
      const fail = (e) => window.__seen.push(e.name + ': ' + e.message);
      p.query({}).catch(fail);
      p.query({name: 'foo'}).catch(fail);
      p.query().catch(fail);
      p.query({name: 'geolocation'}).then((s) => {
        window.__status = s;
        window.__seen.push([s instanceof PermissionStatus, s instanceof EventTarget, s.name, s.state]);
        s.onchange = () => window.__seen.push('change ' + s.state);
      });
      window.__seen.push([typeof p.request, typeof p.revoke, String(p)]);
    JS
    expect(session.evaluate_script('window.__seen')).to eq(
      [
        ['undefined', 'undefined', '[object Permissions]'],
        "TypeError: Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': Required member is undefined.",
        "TypeError: Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value 'foo' is not a valid enum value of type PermissionName.",
        "TypeError: Failed to execute 'query' on 'Permissions': 1 argument required, but only 0 present.",
        [true, true, 'geolocation', 'prompt']
      ]
    )
    session.driver.set_geolocation(denied: true)
    session.driver.set_geolocation(denied: true)
    expect(session.evaluate_script('[window.__seen.slice(5), window.__status.state]')).to eq([['change denied'], 'denied'])
  end

  it "runs a member as the realm of the object it is called on, a frame's on the page's Geolocation the page's" do
    session.driver.set_geolocation(latitude: 1, longitude: 2)
    session.execute_script(<<~JS)
      window.__seen = [];
      const frame = document.body.appendChild(document.createElement('iframe')).contentWindow;
      const id = navigator.geolocation.watchPosition((p) => window.__seen.push('top ' + p.coords.latitude));
      frame.Geolocation.prototype.clearWatch.call(navigator.geolocation, id);
      window.__other = frame.Geolocation.prototype.watchPosition.call(navigator.geolocation, () => {});
    JS
    session.driver.set_geolocation(latitude: 3, longitude: 4)
    expect(session.evaluate_script('[window.__seen, window.__other]')).to eq([[], 2])
  end

  it "tells a worker's PermissionStatus its state moved" do
    session.execute_script(<<~JS)
      window.__seen = [];
      new Worker('/w.js').onmessage = (e) => window.__seen.push(e.data);
    JS
    expect(poll_until { session.evaluate_script('window.__seen.length') == 1 && session.evaluate_script('window.__seen') }).to eq(['init prompt'])
    session.driver.set_geolocation(denied: true)
    expect(poll_until { session.evaluate_script('window.__seen.length') == 2 && session.evaluate_script('window.__seen') }).to eq(['init prompt', 'change denied'])
  end
end
