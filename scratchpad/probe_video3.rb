require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-invalid-args.html")
r = s.evaluate_script("(function(){var v=document.createElement('video');v.preload='auto';v.src='/images/pattern.webm';return 'prop: readyState='+v.readyState+' vw='+v.videoWidth+' vh='+v.videoHeight;})()")
puts r
