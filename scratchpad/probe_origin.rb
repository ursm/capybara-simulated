require_relative '../spec/support/wpt_runner'
s = WptRunner.session
s.driver.reset!
s.visit("/webmessaging/broadcastchannel/basics.any.html")
puts s.evaluate_script("String(location.origin) + ' | structuredClone=' + (typeof structuredClone)")
