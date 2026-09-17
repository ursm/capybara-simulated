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
# cause it stands in for: when the sticky entry retired, a POSITIONED-box refusal went with it, and the
# relative FLOAT below is what puts one back (`layout.js`'s float arm still defers that one — it carries an
# offset native would have to apply).
module WalkRefusals
  ATOMIC = [
    '<span style="display:inline-block"><div style="float:left;position:relative;width:9px;height:4px"></div>t</span>',
    '<span style="display:inline-block;white-space:pre">   </span>',
    '<span style="display:inline-block"><div style="display:table-cell">c</div></span>'
  ].freeze
end
