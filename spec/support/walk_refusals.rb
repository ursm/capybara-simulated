# Content the harness WALK refuses to lay out natively, for a reason the gates' `nlIntrinsicMeasurable` /
# `nlFlexNativeSizable` pre-filters do not model. Every route with a fallback has to survive these by trying and
# rolling back (`emitAttempt`) rather than by asking a predicate, so each route's spec sweeps the same list —
# one list, so a new refusal is added in one place and every route is held to it. An entry LEAVES it when
# native takes the shape over (an out-of-flow child of a text block did, with the static position it reads off
# the line); the routes' specs then sweep one shape fewer, which is the point of keeping them here.
module WalkRefusals
  ATOMIC = [
    '<span style="display:inline-block;width:fit-content">t<div>x</div></span>',
    '<span style="display:inline-block"><div style="position:sticky;top:0">s</div></span>',
    '<span style="display:inline-block"><div style="float:left;width:9px;height:4px"></div>t</span>',
    '<span style="display:inline-block;white-space:pre">   </span>',
    '<span style="display:inline-block"><div style="display:table-cell">c</div></span>',
    '<span style="display:inline-block;width:max-content">bb</span>',
    '<span style="display:inline-block;width:min-content">bb cc</span>'
  ].freeze
end
