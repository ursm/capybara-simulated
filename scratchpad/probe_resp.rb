require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-drawImage.html")
r = s.evaluate_script(<<~JS)
  (function(){
    var resp = globalThis.__rackFetch('GET','/images/pattern.png','',null,'follow');
    return JSON.stringify({keys:Object.keys(resp), ct:resp.headers&&resp.headers['content-type'], bodyLen:resp.body&&resp.body.length, b64: (typeof resp.body_b64), b64len: resp.body_b64&&resp.body_b64.length});
  })()
JS
puts r
