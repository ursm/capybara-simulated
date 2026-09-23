# frozen_string_literal: true
# The three outcomes of a shadow-walk comparison, and the one that used to be invisible.
#
# A pass DECLINES (`ok` false), or it compares boxes and some MISMATCH — and those two are what every parity
# spec here has always asserted. The third is a DROPPED record: `emitAttempt` takes an element's record off the
# stream when a subtree declines, and most callers have a fallback that re-walks it or replays a box accounting
# for its geometry. One that does NOT leaves a box the pass reports and never placed, and the compare walks the
# RECORDS — so a missing one is an element fewer and the run is green.
#
# That is not hypothetical. On 2026-09-23 a refusal covering exactly that hole was lifted after an audit read
# "342 shapes lay out, 0 mismatch"; it had dropped 372 boxes, and three separate sweeps plus the converted spec
# all reported clean. `droppedRecords` comes off `__csimLayoutShadowRun` for this, and asserting it is what
# makes "the two engines agree" distinguishable from "native was never asked".
module ShadowParity
  def expect_no_dropped_records(result, body = '(shadow pass)')
    dropped = result['droppedRecords'].to_i
    expect(dropped).to(
      eq(0),
      "#{body}: the pass reports #{dropped} box(es) it never placed — a rollback with no fallback. " \
      'A dropped record compares as nothing, so this would otherwise read as a clean pass.'
    )
  end
end

RSpec.configure { |c| c.include ShadowParity }
