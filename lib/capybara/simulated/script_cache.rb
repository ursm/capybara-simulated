# frozen_string_literal: true

require 'digest'
require 'fileutils'

module Capybara
  module Simulated
    # Process-wide + on-disk cache of V8 `ScriptCompiler::CachedData`
    # blobs keyed by `(version_tag, sha256(body))`. V8Runtime feeds
    # every `__csim_runScript` body through here so the second visit
    # (and every subsequent process) skips the parse + JIT step on
    # large app bundles — Discourse's main chunk goes from ~140 ms of
    # recompile per visit to a deserialize + run path.
    #
    # Cross-process portability requires snapshot-bytes equality:
    # `MiniRacer::Snapshot.new(source)` is non-deterministic, so the
    # blobs we produce here are only consumable by another process if
    # that process loads the SAME snapshot bytes via `Snapshot.load`.
    # `V8Runtime.build_snapshot` handles that side.
    #
    # **Produce path stays at top level.** `Context#compile(produce_
    # cache: true)` is unsafe inside a host-fn callback (V8's
    # `CreateCodeCache` corrupts the parser when re-entered — mini_racer
    # raises immediately). The host-fn consumer queues misses;
    # `V8Runtime#call` drains the queue from top-level Ruby after each
    # bridge call returns.
    module ScriptCache
      DEFAULT_DIR = File.join(ENV['HOME'] || '/tmp', '.cache', 'capybara-simulated', 'script-cache')

      @lock     = Mutex.new
      @mem      = {}
      @pending  = {}
      @writer_q = nil
      @writer_t = nil

      at_exit { ScriptCache.flush! }

      class << self
        def dir = ENV['CSIM_SCRIPT_CACHE_DIR'] || DEFAULT_DIR
        def enabled? = !ENV['CSIM_SCRIPT_CACHE'].to_s.casecmp('off').zero?

        def lookup(sha, version_tag)
          return nil unless enabled?
          key = cache_key(sha, version_tag)
          mem_hit = @lock.synchronize { @mem[key] }
          return mem_hit if mem_hit
          blob = File.binread(disk_path_for(sha, version_tag)) rescue nil
          return nil unless blob
          @lock.synchronize { @mem[key] ||= blob }
        end

        def store(sha, version_tag, blob)
          return unless enabled? && blob
          key = cache_key(sha, version_tag)
          @lock.synchronize { @mem[key] = blob }
          enqueue_disk_write(disk_path_for(sha, version_tag), blob)
        end

        def queue_warm(ctx, sha, label, body, version_tag)
          return unless enabled?
          key = cache_key(sha, version_tag)
          @lock.synchronize {
            return if @mem.key?(key) || @pending.key?(sha)
            @pending[sha] = {ctx: ctx, label: label, body: body, version_tag: version_tag}
          }
        end

        def warm_pending!
          # Fast path: `V8Runtime#call` drains here after every host-fn
          # call (including hot polling like `__settleGenGet` /
          # `__hasReadyTimer`), so the empty-queue branch must not pay
          # the mutex round-trip. `@pending.empty?` lock-free read is
          # safe — at worst a queued miss waits one extra `call`.
          return unless enabled? && !@pending.empty?
          pending = @lock.synchronize { p = @pending; @pending = {}; p }
          return if pending.empty?
          pending.each_value {|job|
            ctx = job[:ctx]
            next unless ctx.respond_to?(:compile)
            begin
              script = ctx.compile(job[:body], filename: job[:label].to_s, produce_cache: true)
              blob   = script.cached_data
              script.dispose
              store(Digest::SHA256.hexdigest(job[:body]), job[:version_tag], blob) if blob
            rescue StandardError
              # Best effort: a script that fails to produce a cache
              # just keeps doing a parse-from-source next encounter.
            end
          }
        end

        def flush!
          q = @lock.synchronize { @writer_q }
          return unless q
          done = Queue.new
          q.push([:sync, done])
          done.pop
        end

        private

        def cache_key(sha, version_tag) = "#{version_tag}/#{sha}"

        def disk_path_for(sha, version_tag)
          File.join(dir, version_tag.to_s, "#{sha}.bin")
        end

        # Single background writer serialises disk I/O so the host-fn
        # callback returns immediately. Parallel-worker writes to the
        # same path are made safe by the tempfile+rename pattern.
        def enqueue_disk_write(path, blob)
          q = @lock.synchronize {
            unless @writer_q
              @writer_q = Queue.new
              @writer_t = Thread.new { writer_loop(@writer_q) }
              @writer_t.name = 'csim-script-cache-writer'
            end
            @writer_q
          }
          q.push([:write, path, blob])
        end

        def writer_loop(q)
          while (job = q.pop)
            case job[0]
            when :write
              _, path, blob = job
              write_atomically(path, blob) rescue nil
            when :sync
              job[1].push(:done)
            end
          end
        end

        def write_atomically(path, blob)
          FileUtils.mkdir_p(File.dirname(path))
          tmp = "#{path}.#{Process.pid}.#{Thread.current.object_id}.tmp"
          File.binwrite(tmp, blob)
          File.rename(tmp, path)
        end
      end
    end
  end
end
