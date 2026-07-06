require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-invalid-args.html")
%w[/images/pattern.webm /images/pattern.mp4 /images/pattern.png].each do |u|
  r = s.evaluate_script("(function(){try{var b=globalThis.__csim_videoBytesB64(#{u.inspect}); return b? ('OK len='+b.length):'NIL';}catch(e){return 'ERR '+e;}})()")
  puts "#{u} => #{r}"
end
# Now test full video decode
r = s.evaluate_script(<<~JS)
  (function(){
    var v = document.createElement('video');
    v.preload='auto';
    v.src='/images/pattern.webm';
    return 'readyState='+v.readyState+' vw='+v.videoWidth+' vh='+v.videoHeight;
  })()
JS
puts "video after src: #{r}"
