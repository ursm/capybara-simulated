require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/webmessaging/broadcastchannel/interface.any.html")
puts s.evaluate_script("(function(){try{structuredClone(Symbol());return 'no throw (Symbol)';}catch(e){return e.name+': '+e.message;}})()")
puts s.evaluate_script("(function(){try{structuredClone(function(){});return 'no throw (fn)';}catch(e){return e.name;}})()")
