# frozen_string_literal: true

# A full collection of the session's isolate, again until the block holds (or `tries` run out), for a spec that counts
# what a collection let go of. The C++ heap sweeps what a collection found dead on its own threads, so under load — a
# parallel gate's — the count a handle's sweep moves can trail the collection that found it dead.
def collect_garbage(session, tries: 20)
  runtime = session.driver.browser.instance_variable_get(:@runtime).ctx
  tries.times do
    session.evaluate_script('0')
    2.times { runtime.low_memory_notification }
    break if !block_given? || yield
  end
end
