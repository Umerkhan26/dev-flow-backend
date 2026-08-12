import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  syncRepositoryPullRequests,
  type SyncOptions,
} from "../integrations/github/github.sync.js";

const SYNC_QUEUE = "devflow-repo-sync";

type SyncJobData = {
  repositoryId: string;
  options?: SyncOptions;
};

let connection: Redis | null = null;
let syncQueue: Queue<SyncJobData> | null = null;
let worker: Worker<SyncJobData> | null = null;
let redisReady = false;

function connectionOpts(): ConnectionOptions {
  return connection as unknown as ConnectionOptions;
}

export function jobsEnabled() {
  return redisReady;
}

export async function initJobSystem() {
  if (!env.REDIS_URL) {
    console.log("Jobs: REDIS_URL not set — using inline sync fallback");
    return;
  }

  try {
    connection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    await connection.connect();
    await connection.ping();

    syncQueue = new Queue<SyncJobData>(SYNC_QUEUE, { connection: connectionOpts() });

    worker = new Worker<SyncJobData>(
      SYNC_QUEUE,
      async (job) => {
        await syncRepositoryPullRequests(job.data.repositoryId, {
          silent: true,
          ...job.data.options,
        });
      },
      {
        connection: connectionOpts(),
        concurrency: 2,
      },
    );

    worker.on("failed", (job, err) => {
      console.error("Repo sync job failed", job?.id, err.message);
    });

    redisReady = true;
    console.log("Jobs: BullMQ repo-sync worker ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Jobs: Redis unavailable (${message}) — inline sync fallback`);
    redisReady = false;
    syncQueue = null;
    if (worker) {
      await worker.close().catch(() => undefined);
      worker = null;
    }
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  }
}

export async function shutdownJobSystem() {
  await worker?.close().catch(() => undefined);
  await syncQueue?.close().catch(() => undefined);
  connection?.disconnect();
  worker = null;
  syncQueue = null;
  connection = null;
  redisReady = false;
}

/**
 * Enqueue a repo sync. Uses BullMQ when Redis is up; otherwise setImmediate fallback.
 * Dedupes in-flight jobs per repository when queued.
 */
export async function enqueueRepoSync(
  repositoryId: string,
  options: SyncOptions = {},
): Promise<{ mode: "queue" | "inline" }> {
  if (redisReady && syncQueue) {
    try {
      await syncQueue.add(
        "sync",
        { repositoryId, options },
        {
          jobId: `repo-sync-${repositoryId}`,
          removeOnComplete: 50,
          removeOnFail: 30,
          attempts: 3,
          backoff: { type: "exponential", delay: 2500 },
        },
      );
      return { mode: "queue" };
    } catch (err) {
      // Same jobId already waiting/active — that's fine (deduped)
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|Job.*exist/i.test(msg)) {
        return { mode: "queue" };
      }
      console.warn("Jobs: enqueue failed, falling back inline", msg);
    }
  }

  setImmediate(() => {
    void syncRepositoryPullRequests(repositoryId, {
      silent: true,
      ...options,
    }).catch((err) => {
      console.error("Repository sync failed", repositoryId, err);
    });
  });
  return { mode: "inline" };
}
