require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-drawImage.html")
s.evaluate_script(<<~JS)
  window.__p=null;
  (async function(){
    try{
      var blob = await new Promise(function(res,rej){var x=new XMLHttpRequest();x.open('GET','/images/pattern.png');x.responseType='blob';x.onload=function(){res(x.response)};x.onerror=rej;x.send();});
      var info = {size: blob.size, type: blob.type};
      // Try decode via arrayBuffer bytes
      var ab = await blob.arrayBuffer();
      var u8 = new Uint8Array(ab);
      info.abLen = u8.length;
      info.firstBytes = Array.from(u8.slice(0,8));
      window.__p = JSON.stringify(info);
    }catch(e){ window.__p='ERR '+e; }
  })();
JS
12.times { s.driver.run_event_loop_frame(16); break if s.driver.peek_script('window.__p') }
puts s.driver.peek_script('window.__p').inspect
# Also check what the img element (which works) does with same file
r = s.evaluate_script("(function(){var i=new Image(); i.src='/images/pattern.png'; return 'img nat='+i.naturalWidth+'x'+i.naturalHeight;})()")
puts r
