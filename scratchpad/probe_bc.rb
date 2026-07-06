require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/webmessaging/broadcastchannel/basics.any.html")
s.evaluate_script(<<~JS)
  window.__bc=null;
  (function(){
    var c1=new BroadcastChannel('probe'), c2=new BroadcastChannel('probe'), c3=new BroadcastChannel('probe');
    var events=[];
    c1.onmessage=function(e){events.push('c1:'+e.data)};
    c2.onmessage=function(e){events.push('c2:'+e.data)};
    c3.onmessage=function(e){events.push('c3:'+e.data)};
    c2.addEventListener('message', function(e){ c2.close(); });
    c3.addEventListener('message', function(e){ if(e.data=='done'){ window.__bc=JSON.stringify(events); } });
    c1.postMessage('first'); c1.postMessage('done');
  })();
JS
10.times { s.driver.run_event_loop_frame(16); break if s.driver.peek_script('window.__bc') }
puts s.driver.peek_script('window.__bc').inspect
