# Content the harness WALK refuses to lay out natively, for a reason the gates' `nlIntrinsicMeasurable` /
# `nlFlexNativeSizable` pre-filters do not model. Every route with a fallback has to survive these by trying and
# rolling back (`emitAttempt`) rather than by asking a predicate, so each route's spec sweeps the same list —
# one list, so a new refusal is added in one place and every route is held to it. An entry LEAVES it when
# native takes the shape over (an out-of-flow child of a text block did, with the static position it reads off
# the line; a `position: sticky` child did, once the walk learned its box is a static one's; an intrinsic-size
# KEYWORD width did, once the atomic path took `content_sized_width`; a float beside text did, once floats became
# markers in the run stream); the routes' specs then sweep one shape fewer, which is the point of keeping them here.
#
# ONE REASON PER ENTRY — the list is a set of refusal causes, not of shapes. A replacement has to keep the
# cause it stands in for, and it has to be found rather than assumed: the POSITIONED-box cause has changed
# hands twice (the sticky entry retired when the walk learned a sticky box's box is a static one's; the
# relative FLOAT that replaced it retired on 2026-09-20 when the float arms learned the same), and the second
# retirement was nearly recorded as "the cause is gone" on a probe of the four canonical keywords. It is not
# gone. Every one of these gates tests the position as a STRING (`p !== 'static' && p !== 'relative' &&
# p !== 'sticky'`, six copies), and `computePosition` hands over the declared value lowercased with no keyword
# normalisation — so a VENDOR ident a stylesheet can really carry walks straight into them. `-webkit-sticky`
# is that ident: declaration validation keeps it where it drops `position: bogus`, and it declines in all
# seven routes that sweep this list, byte-identically to the entry below it.
# (Chrome removed the alias — `getComputedStyle` there answers `static`, where this engine answers
# `-webkit-sticky`. Normalising an unknown `position` keyword to `static` in `computePosition` would retire
# the cause at its source AND fix that read; it is a cascade/CSSOM change and wants its own increment. Until
# then the cause stands, and stands here.)
# …and each entry is NAMED, because every retirement so far has silently re-pointed the `.first` / `.last`
# a consumer used: dropping the head moved `.first` from the relative float to the whitespace-only
# inline-block, and both specs went on passing while testing a different cause than their comment said.
module WalkRefusals
  # …the positioned one's CONTENT on its own, because what it declines for as a BLOCK is the property some
  # callers actually need: an atomic whose content declines for a NAMED reason is the only kind that
  # exercises the walk's rollback, and a caller that wants that has to be able to say so.
  POSITIONED_INNER = '<div style="position:-webkit-sticky;width:9px;height:4px"></div>t'
  POSITIONED       = %(<span style="display:inline-block">#{POSITIONED_INNER}</span>)
  WHITESPACE       = '<span style="display:inline-block;white-space:pre">   </span>'
  TABLE_CELL       = '<span style="display:inline-block"><div style="display:table-cell">c</div></span>'
  ATOMIC           = [POSITIONED, WHITESPACE, TABLE_CELL].freeze
end
