require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-drawImage.html")
s.evaluate_script(<<~JS)
  window.__f=null;
  (async function(){
    try{
      var blob = await new Promise(function(res,rej){var x=new XMLHttpRequest();x.open('GET','/images/pattern.png');x.responseType='blob';x.onload=function(){res(x.response)};x.onerror=rej;x.send();});
      function sample(bm){var c=document.createElement('canvas');c.width=bm.width;c.height=bm.height;var ctx=c.getContext('2d');ctx.drawImage(bm,0,0);var w=bm.width,h=bm.height;return [[w/4,h/4],[w/4,3*h/4]].map(function(p){var d=ctx.getImageData(p[0]|0,p[1]|0,1,1).data;return[d[0],d[1],d[2]];});}
      var normal = await createImageBitmap(blob);
      var flip = await createImageBitmap(blob,{imageOrientation:'flipY'});
      var crop = await createImageBitmap(blob,0,0,10,10);  // top-left red quadrant only
      window.__f = JSON.stringify({normal_TLBL:sample(normal), flipY_TLBL:sample(flip), crop_dims:[crop.width,crop.height]});
    }catch(e){window.__f='ERR '+e;}
  })();
JS
12.times { s.driver.run_event_loop_frame(16); break if s.driver.peek_script('window.__f') }
puts s.driver.peek_script('window.__f')
