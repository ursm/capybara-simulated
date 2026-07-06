require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/webmessaging/broadcastchannel/basics.any.html")
puts s.evaluate_script(<<~JS)
  (function(){
    var x = new XMLHttpRequest();
    var results = [];
    x.onload = {}; results.push('obj:'+(typeof x.onload));       // should store {} -> 'object'
    x.onload = 42; results.push('num:'+(x.onload===null));       // primitive -> null -> true
    var f=function(){}; x.onload=f; results.push('fn:'+(x.onload===f));  // true
    var c = new BroadcastChannel('t'); c.onmessage = {}; results.push('bc:'+(typeof c.onmessage));  // 'object'
    return results.join(' ');
  })()
JS
