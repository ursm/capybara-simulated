require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/html/canvas/element/manual/imagebitmap/createImageBitmap-drawImage.html")
s.evaluate_script(<<~JS)
  window.__probe=null;
  (async function(){
    function sample(bm){
      var c=document.createElement('canvas'); c.width=bm.width; c.height=bm.height;
      var ctx=c.getContext('2d'); ctx.drawImage(bm,0,0);
      var w=bm.width,h=bm.height;
      var pts=[[w/4,h/4],[3*w/4,h/4],[w/4,3*h/4],[3*w/4,3*h/4]];
      return pts.map(function(p){var d=ctx.getImageData(p[0]|0,p[1]|0,1,1).data; return [d[0],d[1],d[2],d[3]];});
    }
    try {
      var blob = await new Promise(function(res,rej){var x=new XMLHttpRequest();x.open('GET','/images/pattern.png');x.responseType='blob';x.onload=function(){res(x.response)};x.onerror=rej;x.send();});
      var bbm = await createImageBitmap(blob);
      var v=document.createElement('video'); v.preload='auto'; v.src='/images/pattern.webm';
      var vbm = await createImageBitmap(v);
      window.__probe = JSON.stringify({blob:{w:bbm.width,h:bbm.height,px:sample(bbm)}, video:{w:vbm.width,h:vbm.height,px:sample(vbm)}});
    } catch(e){ window.__probe = 'ERR '+e+' '+(e&&e.stack); }
  })();
JS
10.times { s.driver.run_event_loop_frame(16); break if s.driver.peek_script('window.__probe') }
puts s.driver.peek_script('window.__probe').inspect
