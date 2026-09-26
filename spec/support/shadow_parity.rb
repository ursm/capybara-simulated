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
    # …and the same two holes in the inline boxes' FRAGMENTS: one a rolled-back gather tabled and nothing tabled
    # again, and one native returned no row for at all.
    lost = result.slice('fragsDropped', 'fragsMissing').transform_values(&:to_i)
    expect(lost.values.sum).to eq(0), "#{body}: inline fragments never laid out: #{lost.inspect} #{result['fragSample'].inspect}"
    # …and the fragments native DID lay out, which a box's own record says nothing about: an empty `<span>` is a
    # zero-width box either way, and whether it has a height, and where, is a fragment question.
    expect(result['fragMismatches'].to_i).to eq(0), "#{body}: inline fragments laid out differently: #{result['fragSample'].inspect}"
    # …and what a geometry read takes off a box besides its rectangle — the basis its percentage edges resolve
    # against and the margins its placement used — which the flip writes from native too.
    expect(result['usedMismatches'].to_i).to eq(0), "#{body}: used edges differ: #{result['usedSample'].inspect}"
  end

  # `#m`'s laid-out rectangle, `[x, y, width, height]`, on a fresh page of `body` — the figure a spec holds against
  # Chrome's. Asks the example group's own `page`, so it reads the document the parity run reads.
  def laid_out_rect(body, id = 'm')
    session = simulated_session(page(body))
    session.visit '/'
    session.evaluate_script("(r => [r.x, r.y, r.width, r.height])(document.getElementById('#{id}').getBoundingClientRect())")
  end

  # A figure BOTH engines share and Chrome does not — recorded rather than fixed while the port runs, and pinned
  # so the pair cannot drift apart unnoticed.
  #
  # Checked CHROME FIRST, and that order is the whole point of having one helper for it. Written inline, every
  # copy asserted the shared figure first and the Chrome tripwire second — so the day an engine moved onto
  # Chrome's number, the shared assertion failed with a message about a regression and the one that would have
  # said "this is a FIX, pin Chrome's number now" was never reached. Four copies had that order; none could fire.
  def expect_shared_gap(got, shared:, chrome:, what:)
    unless (shared - chrome).abs <= 0.05
      expect(got).not_to(
        be_within(0.05).of(chrome),
        "#{what}: #{got} now AGREES with Chrome (#{chrome}) — a fix, not a regression: pin it as Chrome's figure"
      )
    end
    expect(got).to be_within(0.05).of(shared), "#{what}: #{got}; both engines say #{shared}, Chrome says #{chrome}"
  end
end

RSpec.configure {|c| c.include ShadowParity }
