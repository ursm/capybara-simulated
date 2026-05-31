# Dev helper: regenerate spec/support/idl_known_gaps.yml from a live probe of
# the VM, listing exactly the IDL members currently absent (deduped, sorted).
# Run after implementing members so the symmetric coverage gate stays honest.
#
#   bundle exec ruby script/regen_idl_gaps.rb
require 'json'
require 'yaml'
require 'capybara/simulated'

ROOT = File.expand_path('..', __dir__)
SURFACE = JSON.parse(File.read("#{ROOT}/spec/support/idl_members.json"))

PROBES = {
  'Navigator'   => {instance: 'navigator'},
  'Geolocation' => {instance: 'navigator.geolocation'},
  'Permissions' => {instance: 'navigator.permissions'},
  'Performance' => {instance: 'performance'},
  'History'     => {instance: 'history'},
  'Location'    => {instance: 'location'},
  'Storage'     => {instance: 'localStorage'},
  'Document'    => {instance: 'document'},
  'Node'        => {instance: 'document'},
  'Element'     => {instance: "document.createElement('div')"},
  'HTMLElement' => {instance: "document.createElement('div')"},
  'HTMLInputElement'  => {instance: "document.createElement('input')"},
  'HTMLFormElement'   => {instance: "document.createElement('form')"},
  'HTMLAnchorElement' => {instance: "document.createElement('a')"},
  'Event'       => {instance: "new Event('x')", ctor: 'Event'},
  'CustomEvent' => {instance: "new CustomEvent('x')"},
  'EventTarget' => {instance: 'new EventTarget()'},
  'URL'         => {instance: "new URL('https://e.test/')", ctor: 'URL'},
  'URLSearchParams' => {instance: 'new URLSearchParams()'}
}.freeze

def missing(session, names, expr)
  names = names.uniq
  return [] if names.empty?
  js = <<~JS
    (() => {
      let target;
      try { target = (#{expr}); } catch (e) { return #{names.to_json}; }
      if (target == null) return #{names.to_json};
      const obj = Object(target);
      const out = [];
      for (const n of #{names.to_json}) {
        let present = false;
        try { present = (typeof target[n] !== 'undefined') || (n in obj); }
        catch (e) { present = true; }
        if (!present) out.push(n);
      }
      return out;
    })()
  JS
  Array(session.evaluate_script(js))
end

app = ->(_e) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
session = Capybara::Session.new(:simulated, app)
session.visit '/'

gaps = {}
PROBES.each do |iface, probe|
  surface = SURFACE[iface]
  next unless surface
  m = []
  m += missing(session, surface['members'], probe[:instance]) if probe[:instance]
  m += missing(session, surface['static'], probe[:ctor]) if probe[:ctor]
  m = m.uniq.sort
  gaps[iface] = m unless m.empty?
end

hdr = <<~H
  # Known WebIDL existence gaps — members declared in the spec surface
  # (spec/support/idl_members.json) that the driver does not yet expose.
  #
  # The idl_coverage_spec gate is symmetric: a gap not listed here turns the
  # suite RED (implement it or add it here), and an entry here that is now
  # present ALSO turns it RED (delete the stale line). Shrinking this file is
  # the spec-compliance backlog made measurable. Regenerate after implementing
  # members with: bundle exec ruby script/regen_idl_gaps.rb
  #
  # Remaining entries are dominated by: layout-engine geometry (clientLeft,
  # getBoxQuads, convert*FromNode), fullscreen / pointer-lock / view-transitions,
  # device / streaming / privacy-sandbox navigator APIs (all OUT OF SCOPE), plus
  # in-scope-but-deferred work: most HTMLInputElement reflection (max/min/step/
  # labels/valueAs*), element-reference ARIA reflection, and Document write-stream.
H
body = gaps.keys.sort.map {|iface|
  "#{iface}:\n" + gaps[iface].map {|mm| "  - #{mm}" }.join("\n")
}.join("\n")
File.write("#{ROOT}/spec/support/idl_known_gaps.yml", hdr + body + "\n")
total = gaps.values.sum(&:size)
puts "wrote allowlist: #{gaps.size} interfaces, #{total} members"
puts "CustomEvent_initCustomEvent_still_missing=#{(gaps['CustomEvent'] || []).include?('initCustomEvent')}"
