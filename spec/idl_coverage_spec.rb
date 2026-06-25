# frozen_string_literal: true

require 'json'
require 'yaml'
require 'set'
require 'capybara/simulated'

# WebIDL existence-coverage gate.
#
# `spec/support/idl_members.json` is the distilled member surface of every
# web-platform spec (generated from @webref/idl by
# `script/gen_idl_surface.mjs`). For a curated set of interfaces — the ones a
# real app actually reaches at runtime — we probe each IDL-declared member for
# *existence* in the VM (`member in instance`). This catches whole-API gaps
# (the class of bug where `navigator.geolocation` simply doesn't exist and a
# page dies with a TypeError) that behavioural specs never reach because they
# assume the surface is there.
#
# Scope: EXISTENCE only — not behaviour. A member counts as present if it's on
# the instance or its prototype chain. Behavioural correctness is the job of
# the dedicated specs (browser_globals_spec, geolocation_spec, …) and, later,
# the WPT subset.
#
# Known gaps live in `spec/support/idl_known_gaps.yml` (interface => [members]).
# The gate is symmetric, mirroring the expected-failures discipline:
#   - a missing member NOT in the allowlist  -> RED (new gap / regression)
#   - an allowlisted member that now EXISTS   -> RED (stale entry; delete it)
# So filling a gap forces its allowlist line to be removed, and a regression
# that deletes a member turns the suite red immediately.
#
# `PROBES` maps an interface to a JS expression yielding a representative
# instance. Static members are probed against the constructor. Interfaces with
# no reliable instance expression are simply not probed yet — add them here as
# coverage grows; the point is a ratcheting floor, not day-one completeness.

module IdlCoverage
  SURFACE = JSON.parse(
    File.read(File.expand_path('support/idl_members.json', __dir__))
  ).freeze

  gaps_path = File.expand_path('support/idl_known_gaps.yml', __dir__)
  KNOWN_GAPS = (File.exist?(gaps_path) ? (YAML.safe_load_file(gaps_path) || {}) : {}).freeze

  # ── Per-interface ownership (the inverse of the existence check) ───────────
  # A member declared on a specific HTML element interface must NOT appear on
  # elements of OTHER interfaces (`'disabled' in div` is false in a real browser
  # — disabled is an HTMLButtonElement/Input/… member, not an HTMLDivElement one).
  # Historically every reflected member lived on one shared Element.prototype, so
  # they all leaked onto every element; the per-interface-prototype work moves
  # each onto its owning interface. This gate measures that migration: it asserts
  # interface-specific members are ABSENT on a bare control element, with a
  # ratcheting allowlist of members still leaked (drained as they're relocated).

  # An interface's FULL member surface (own + inherited). Mixin members are
  # already merged into each interface's `members`, so only `inheritance` walks.
  def self.full_members(interface, seen = {})
    return [] if interface.nil? || seen[interface]
    seen[interface] = true
    iface = SURFACE[interface]
    return [] unless iface
    (iface['members'] || []) + full_members(iface['inheritance'], seen)
  end

  # Every HTML element interface (transitively inherits HTMLElement).
  def self.html_element_interfaces
    SURFACE.keys.select do |k|
      next false if k == 'HTMLElement'
      cur = k; chain = []
      while cur && SURFACE[cur] && !chain.include?(cur)
        chain << cur
        cur = SURFACE[cur]['inheritance']
      end
      chain.include?('HTMLElement')
    end
  end

  # The control element to probe: <span> (HTMLSpanElement has zero own members),
  # so its full surface is exactly the bare HTMLElement/Element/Node one.
  CONTROL_TAG = 'span'

  # Members owned by SOME element interface but not part of the control's surface
  # — these must be absent on the control element.
  def self.interface_specific_members
    control = full_members('HTMLSpanElement').to_set
    out = Set.new
    html_element_interfaces.each do |iface|
      next if iface == 'HTMLSpanElement'
      Array(SURFACE[iface]['members']).each { |m| out << m unless control.include?(m) }
    end
    out.to_a.sort
  end

  leaked_path = File.expand_path('support/idl_leaked_members.yml', __dir__)
  LEAKED_ALLOW = (File.exist?(leaked_path) ? Array(YAML.safe_load_file(leaked_path)) : []).freeze

  # interface => { instance: <JS expr for an instance>, ctor: <JS expr for the
  # constructor, for static members> }. Either key may be omitted.
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
    'HTMLOptionsCollection' => {instance: "document.createElement('select').options", ctor: 'HTMLOptionsCollection'},
    'HTMLFormControlsCollection' => {instance: "document.createElement('form').elements", ctor: 'HTMLFormControlsCollection'},
    'RadioNodeList' => {instance: "(function(){var f=document.createElement('form'),a=document.createElement('input'),b=document.createElement('input');a.name='r';b.name='r';f.append(a,b);return f.elements.r;})()", ctor: 'RadioNodeList'},
    'Event'       => {instance: "new Event('x')", ctor: 'Event'},
    'CustomEvent' => {instance: "new CustomEvent('x')"},
    'EventTarget' => {instance: 'new EventTarget()'},
    'URL'         => {instance: "new URL('https://e.test/')", ctor: 'URL'},
    'URLSearchParams' => {instance: 'new URLSearchParams()'}
  }.freeze

  # JS that returns the list of IDL member names NOT present on the probe
  # target. One round-trip per interface. `names` is the IDL member set.
  #
  # A member counts as present if it is readable (`typeof target[n]` is not
  # 'undefined') OR appears on the prototype chain (`n in Object(target)`) OR
  # accessing it throws (it exists but errored — still "present"). The
  # read-based check is primary because the bridge's host objects (document,
  # DOM nodes) expose members via accessors that `in` does not always report,
  # the same way real-world feature detection reads the property rather than
  # trusting `in`.
  def self.missing_members(session, interface, names, expr, kind)
    return [] if names.empty?
    js = <<~JS
      (() => {
        let target;
        try { target = (#{expr}); } catch (e) { return #{names.to_json}; }
        if (target == null) return #{names.to_json};
        const obj = Object(target);
        const names = #{names.to_json};
        const missing = [];
        for (const n of names) {
          let present = false;
          try {
            present = (typeof target[n] !== 'undefined') || (n in obj);
          } catch (e) {
            present = true; // throwing accessor: the member exists
          }
          if (!present) missing.push(n);
        }
        return missing;
      })()
    JS
    Array(session.evaluate_script(js))
  end
end

RSpec.describe 'WebIDL existence coverage' do
  let(:app) {
    ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  IdlCoverage::PROBES.each do |interface, probe|
    context "#{interface}" do
      let(:surface) { IdlCoverage::SURFACE[interface] }
      let(:allowlisted) { Array(IdlCoverage::KNOWN_GAPS[interface]) }

      it 'is described in the IDL surface' do
        expect(surface).not_to be_nil,
          "#{interface} not found in idl_members.json — regenerate via script/gen_idl_surface.mjs"
      end

      it 'exposes every IDL member (or lists it as a known gap)' do
        skip 'no IDL surface' unless surface

        missing = []
        if probe[:instance]
          missing += IdlCoverage.missing_members(session, interface, surface['members'], probe[:instance], :instance)
        end
        if probe[:ctor]
          missing += IdlCoverage.missing_members(session, interface, surface['static'], probe[:ctor], :static)
        end
        missing.uniq!

        new_gaps   = missing - allowlisted
        stale_gaps = allowlisted - missing

        expect(new_gaps).to be_empty,
          "#{interface}: IDL members missing and not allowlisted (implement, or add to " \
          "spec/support/idl_known_gaps.yml): #{new_gaps.sort.join(', ')}"

        expect(stale_gaps).to be_empty,
          "#{interface}: allowlisted as a gap but now PRESENT — remove from " \
          "spec/support/idl_known_gaps.yml: #{stale_gaps.sort.join(', ')}"
      end
    end
  end
end

RSpec.describe 'WebIDL per-interface ownership (members not leaked across interfaces)' do
  let(:app) {
    ->(_env) { [200, {'content-type' => 'text/html'}, ['<!doctype html><html><body></body></html>']] }
  }
  let(:session) { Capybara::Session.new(:simulated, app) }

  before { session.visit '/' }

  it "interface-specific members are absent on a bare <#{IdlCoverage::CONTROL_TAG}> (or listed as a known leak)" do
    want_absent = IdlCoverage.interface_specific_members
    js = <<~JS
      (() => {
        const el = document.createElement('#{IdlCoverage::CONTROL_TAG}');
        return #{want_absent.to_json}.filter((n) => n in el);
      })()
    JS
    leaked = Array(session.evaluate_script(js)).sort
    allow  = IdlCoverage::LEAKED_ALLOW.sort

    new_leaks = leaked - allow
    stale     = allow  - leaked

    expect(new_leaks).to be_empty,
      "interface-specific members leaked onto <#{IdlCoverage::CONTROL_TAG}> — relocate each to its owning " \
      "interface prototype, or add to spec/support/idl_leaked_members.yml: #{new_leaks.join(', ')}"

    expect(stale).to be_empty,
      "members allowlisted as leaked but now correctly absent — remove from " \
      "spec/support/idl_leaked_members.yml: #{stale.join(', ')}"
  end
end
