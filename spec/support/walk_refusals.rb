# Content the harness WALK refuses to lay out natively, for a reason the gates' `nlIntrinsicMeasurable` /
# `nlFlexNativeSizable` pre-filters do not model. Every route with a fallback has to survive these by trying and
# rolling back (`emitAttempt`) rather than by asking a predicate, so each route's spec sweeps the same list —
# one list, so a new refusal is added in one place and every route is held to it.
module WalkRefusals
  ATOMIC = [
    '<span style="display:inline-block;width:fit-content">t<div>x</div></span>',
    '<span style="display:inline-block"><div style="position:sticky;top:0">s</div></span>',
    '<span style="display:inline-block"><div style="float:left;width:9px;height:4px"></div>t</span>',
    '<span style="display:inline-block;position:relative">t<div style="position:absolute">y</div></span>',
    '<span style="display:inline-block;white-space:pre">   </span>',
    '<span style="display:inline-block"><div style="contain:layout;width:9px;height:4px"></div></span>',
    '<span style="display:inline-block;width:max-content">bb</span>',
    '<span style="display:inline-block;width:min-content">bb cc</span>'
  ].freeze
end
