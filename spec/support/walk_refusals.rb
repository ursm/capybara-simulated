# Content the harness WALK refuses to lay out natively, for a reason the gates' `nlIntrinsicMeasurable` /
# `nlFlexPushWhy` pre-filters do not model. Every route with a fallback has to survive these by trying and
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
  # …an orphan `display: table-row` holding an ELEMENT (`flex-container-unsupported`: the oracle LAYS one out as an
  # equal-share flex row, whose sizing native has never had). Its predecessors: a `pre` inline-block of nothing but
  # spaces (`white-space-only-block`) until preserved white space went down the text path, a CENTRED mixed block's
  # out-of-flow box in a group that opens no line (`oof-in-collapsed-group`) until an empty line stopped moving what
  # waits on it — both 2026-09-24 — and an orphan row of bare TEXT until a flex record could carry the run stream its
  # measure reads, 2026-09-26.
  ORPHAN_ROW       = '<span style="display:inline-block"><div style="display:table-row"><div>aa bb</div></div></span>'
  # (An orphan `display: table-cell` inside one was the third entry — `block-level-box-unplaceable`, a DISPLAY the
  # block arm had no case for — until 2026-09-24, when the walk took an orphan table part as the block the oracle
  # lays it out as; `-webkit-box`, `ruby`, `math`, `flow`, an orphan `table-column` and the rest of the oracle's
  # block-flow fallthrough followed on 2026-09-25. What reaches that reason now is the unmodelled POSITION of the
  # first entry.)
  ATOMIC           = [POSITIONED, ORPHAN_ROW].freeze

  # …and a separate cause, for the routes that MEASURE rather than lay out: content whose intrinsic width
  # native has no rule for, which every shrink-to-fit route has to refuse or push while the walk still lays the
  # same content out when it is handed a width. An ATOMIC native does not lay out itself is that shape: the walk
  # PUSHES the oracle's box for it on a line, and a measure has no such box to read — a HALF-EMPTY `inline-table`, a
  # column declared with no row under it (`table-half-empty`: the grid native builds has no row to hang it on), is
  # refused by `nlAtomicMeasurable`, where the walk lays the line out.
  # The refusal is UNNAMED (it surfaces as the asker's `shrink-to-fit-child-unmeasurable`), which is why it is
  # written out here rather than pointed at a reason.
  # It is the NINTH shape to hold the role: an `inline-grid` over bare text, `white-space: break-spaces`, a
  # whitespace-only EDGED inline (a line rule, never a measure gap), a NON-WRAPPING mixed block, a flex whose main
  # gap is a PERCENTAGE, an indented block of an EMPTY inline box (a zero OPEN / CLOSE pair takes the indent now),
  # an `inline-table` with TWO captions (native stacks several since 2026-09-25) and one whose SCROLLING row carried
  # a px bottom margin (both engines give a table-internal box none since 2026-09-26) all retired one after another.
  # A replacement has to be FOUND, by asking which refusals the measure gate makes that the walk does not: a soft
  # hyphen under `break-spaces`, a preserved CR and a block box inside an inline are refused by the WALK as well, so
  # a route handed one declines outright instead of taking the fallback the specs hold it to.
  # If this one retires too, the cause is still real: find the next shape, do not delete the arm.
  UNMEASURABLE = '<div>a<table style="display:inline-table"><colgroup><col style="width:30px"></colgroup></table></div>'
end
