require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-invalid-args.html")
r = s.evaluate_script(<<~JS)
  (function(){
    var b64 = globalThis.__csim_videoBytesB64('/images/pattern.webm');
    var d = globalThis.__csim_decodeVideoFrame(b64);
    return JSON.stringify({b64len:b64&&b64.length, decoded: d ? {w:d.width,h:d.height,dur:d.duration,ref:!!d.refId} : d});
  })()
JS
puts "webm decode: #{r}"
r2 = s.evaluate_script(<<~JS)
  (function(){
    var v = document.createElement('video');
    v.setAttribute('src','/images/pattern.webm');
    return 'afterSetAttr readyState='+v.readyState+' vw='+v.videoWidth;
  })()
JS
puts r2
