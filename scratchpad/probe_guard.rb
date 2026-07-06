require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-drawImage.html")
s.evaluate_script(<<~JS)
  window.__g=null;
  (async function(){
    var out={};
    var id=new ImageData(20,20);
    try{ var a=await createImageBitmap(id,0,0,-20000,10000); out.bigNeg='RESOLVED '+a.width+'x'+a.height; }
    catch(e){ out.bigNeg=e.name; }
    try{ var b=await createImageBitmap(id,5,5,-4,-4); out.smallNeg='RESOLVED '+b.width+'x'+b.height; }
    catch(e){ out.smallNeg='ERR '+e.name; }
    window.__g=JSON.stringify(out);
  })();
JS
8.times { s.driver.run_event_loop_frame(16); break if s.driver.peek_script('window.__g') }
puts s.driver.peek_script('window.__g')
