# frozen_string_literal: true
# Emit lib/capybara/simulated/js/src/idl-owned-members.js — a member → owning-tags
# map distilled from spec/support/idl_members.json (the @webref WebIDL surface) and
# the driver's interface→tag map (TAG_ELEMENT_CTORS / MULTI_TAG_ELEMENT_CTORS in
# dom-class-aliases.js). installDomClassAliases relocates each member from the
# shared Element.prototype onto its owning interface prototype(s), so per-tag IDL
# existence (`'disabled' in div` === false) is spec-correct.
#
# A member is relocated to the tags of every MODELLED HTML element interface that
# owns it (directly or by inheritance — so HTMLMediaElement's play/pause fold into
# <audio>/<video>). It is KEPT on the shared base (not emitted) when:
#   - it's part of the universal HTMLElement/Element/Node surface (id, nonce, …);
#   - it's also owned by an SVG/MathML interface (SVGAElement.rel/relList) — the
#     driver gives foreign elements no interface prototype, so the one accessor
#     must stay shared to keep serving them;
#   - it's owned by an HTML element interface the driver does NOT model (no tag and
#     no modelled descendant — obsolete <marquee> → HTMLUnknownElement), which has
#     no prototype to receive it.
# Re-run after regenerating idl_members.json OR changing the tag map:
#   ruby script/gen_idl_owned_members.rb
require 'json'
require 'set'

ROOT     = File.expand_path('..', __dir__)
SURFACE  = JSON.parse(File.read(File.join(ROOT, 'spec/support/idl_members.json')))
ALIASES  = File.read(File.join(ROOT, 'lib/capybara/simulated/js/src/dom-class-aliases.js'))

# Driver-modelled interface → [tags], read from dom-class-aliases.js so the two
# never drift. Single-tag (`HTMLAnchorElement: 'a'`) + multi-tag (`['del','ins']`).
def block(src, name)
  m = src.match(/const #{name} = \{(.+?)\n\};/m) or raise "#{name} not found"
  m[1]
end
MODELLED = {}
block(ALIASES, 'TAG_ELEMENT_CTORS').scan(/(\w+):\s*'([a-z0-9]+)'/) { |iface, tag| MODELLED[iface] = [tag] }
block(ALIASES, 'MULTI_TAG_ELEMENT_CTORS').scan(/(\w+):\s*\[([^\]]+)\]/) do |iface, tags|
  MODELLED[iface] = tags.scan(/'([a-z0-9]+)'/).flatten
end

def parent(iface) = SURFACE[iface] && SURFACE[iface]['inheritance']

def element_interface?(iface, seen = [])
  return false if iface.nil? || seen.include?(iface) || !SURFACE[iface]
  return true if iface == 'HTMLElement' && !seen.empty?
  element_interface?(parent(iface), seen + [iface])
end

# Members of `iface` resolved up the chain but stopping BEFORE HTMLElement (whose
# members are universal). Folds an intermediate interface (HTMLMediaElement) into
# its tag-bearing descendants.
def resolved_members(iface)
  out = []; cur = iface; seen = []
  while cur && cur != 'HTMLElement' && SURFACE[cur] && !seen.include?(cur)
    seen << cur; out.concat(Array(SURFACE[cur]['members'])); cur = parent(cur)
  end
  out.uniq
end

def full_members(iface, seen = [])
  return [] if iface.nil? || seen.include?(iface) || !SURFACE[iface]
  Array(SURFACE[iface]['members']) + full_members(parent(iface), seen + [iface])
end

# Interfaces "covered" by the driver: every modelled interface and all its
# ancestors (so HTMLMediaElement is covered via HTMLVideoElement/HTMLAudioElement).
covered = {}
MODELLED.each_key do |iface|
  cur = iface
  while cur && SURFACE[cur] && !covered[cur]
    covered[cur] = true
    break if cur == 'HTMLElement'
    cur = parent(cur)
  end
end

universal   = full_members('HTMLElement').to_set
# Members the driver serves for RENDERED foreign (SVG) elements too — it gives SVG
# elements no interface prototype, so the one accessor must stay on the shared base.
# (A blanket "any name on any SVG interface" net is far too wide — `value`/`type`/
# `href` appear on unrelated SVG value-type interfaces; this is the curated set the
# WPT gate flags, e.g. `a.relList` on an SVG <a>.) Bounded gap: SVGAElement's OTHER
# HTML-anchor-shared members (href/target/hreflang/…) ARE relocated, so an SVG <a>
# (not modelled as SVGAElement — it reverts to Element.prototype) loses them; the
# driver was already non-conformant there (SVGAElement.href is an SVGAnimatedString)
# and no gate/app covers it. Add a name here only when the gate demands it.
KEEP_SHARED = %w[rel relList].to_set
# Obsolete element interfaces the driver renders (as HTMLUnknownElement) and whose
# members are PROBED by WPT (reflection-obsolete). Their members must stay on the
# shared base — HTMLUnknownElement has no prototype to receive them. NOT every
# uncovered interface qualifies: experimental ones (<portal>/<fencedframe>/<model>
# /…) are likewise HTMLUnknownElement but untested, so a member they merely co-own
# with a MODELLED interface (img.src + HTMLPortalElement.src) should still relocate
# to the modelled owner — keeping it shared would needlessly leak it onto every
# element. (Curated rather than "all uncovered"; the gate would flag a miss.)
OBSOLETE_KEEP = %w[HTMLMarqueeElement HTMLAppletElement].select { |i| SURFACE[i] }
uncovered_owned = OBSOLETE_KEEP.each_with_object(Set.new) do |iface, acc|
  Array(SURFACE[iface]['members']).each { |m| acc << m }
end

member_tags = Hash.new { |h, k| h[k] = [] }
MODELLED.each do |iface, tags|
  next unless element_interface?(iface)
  resolved_members(iface).each do |m|
    next if universal.include?(m) || KEEP_SHARED.include?(m) || uncovered_owned.include?(m)
    member_tags[m].concat(tags)
  end
end
member_tags.transform_values! { |t| t.uniq.sort }

out = +"// GENERATED by script/gen_idl_owned_members.rb from spec/support/idl_members.json\n"
out << "// + the TAG_ELEMENT_CTORS map in dom-class-aliases.js. Maps each interface-specific\n"
out << "// IDL member to the element tags whose interface prototype should own it (relocated\n"
out << "// off the shared Element.prototype by installDomClassAliases). Do not edit by hand.\n"
out << "export const IDL_MEMBER_TAGS = #{JSON.pretty_generate(member_tags.sort.to_h)};\n"
File.write(File.join(ROOT, 'lib/capybara/simulated/js/src/idl-owned-members.js'), out)
warn "wrote #{member_tags.size} relocatable members across #{MODELLED.size} modelled interfaces"
