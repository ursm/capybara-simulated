# frozen_string_literal: true

# Deadline-based presence-wait for cross-thread work (worker / service-worker
# threads, frame loads) a spec must observe before asserting. Returns the
# block's first truthy value, or the final (falsy) value once the deadline
# passes — the caller's assertion then reports the real mismatch.
#
# The default bound is generous on purpose: it exits on the first truthy poll,
# so a healthy run never pays it, while a loaded parallel runner (CI runs one
# worker per vCPU; a worker thread competes with all of them for real time)
# gets the wall it actually needs. Sub-second hand-rolled polls are
# load-fragile by construction — the parallel CI flaked two of them (a worker
# echo, an SW install reaching `waiting`) before this helper replaced the
# pattern.
module PollUntil
  def poll_until(timeout: 10)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      value = yield
      return value if value
      break if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      sleep 0.02
    end
    yield
  end
end

RSpec.configure do |config|
  config.include PollUntil
end
