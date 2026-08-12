import { prisma } from "../../database/prisma.js";
import { decryptSecret } from "../../utils/crypto.js";
import { notifyWorkspaceMembers } from "../../realtime/socket.js";
import {
  listGithubPullRequests,
  listGithubWorkflowRuns,
  type GithubPull,
} from "./github.client.js";

function mapPrState(pr: GithubPull) {
  if (pr.merged_at) return "MERGED" as const;
  if (pr.state === "closed") return "CLOSED" as const;
  return "OPEN" as const;
}

export type SyncOptions = {
  /** Base branch PRs must target. Null/empty = all base branches. */
  baseBranch?: string | null;
  /** Skip workspace notifications (e.g. background link sync). */
  silent?: boolean;
};

function topBaseBranches(pulls: GithubPull[], limit = 5) {
  const counts = new Map<string, number>();
  for (const pr of pulls) {
    const ref = pr.base?.ref?.trim();
    if (!ref) continue;
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export async function syncRepositoryPullRequests(
  repositoryId: string,
  options: SyncOptions = {},
) {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { connection: true },
  });
  if (!repository) throw new Error("Repository not found");

  const baseBranch =
    options.baseBranch !== undefined
      ? options.baseBranch?.trim() || null
      : repository.syncBaseBranch;

  await prisma.repository.update({
    where: { id: repositoryId },
    data: {
      syncStatus: "SYNCING",
      lastSyncError: null,
      ...(options.baseBranch !== undefined ? { syncBaseBranch: baseBranch } : {}),
    },
  });

  try {
    const token = decryptSecret(repository.connection.accessTokenEnc);

    // Sample without base filter so we can hint which bases actually exist
    const sampleForHints = baseBranch
      ? await listGithubPullRequests(token, repository.owner, repository.name)
      : [];

    const pulls = await listGithubPullRequests(token, repository.owner, repository.name, {
      base: baseBranch,
    });
    const scanned = baseBranch ? sampleForHints.length : pulls.length;
    const commonBases = topBaseBranches(baseBranch ? sampleForHints : pulls);

    for (const pr of pulls) {
      await prisma.pullRequest.upsert({
        where: {
          repositoryId_githubPrId: {
            repositoryId,
            githubPrId: String(pr.id),
          },
        },
        create: {
          repositoryId,
          githubPrId: String(pr.id),
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: mapPrState(pr),
          draft: pr.draft,
          authorLogin: pr.user?.login ?? "unknown",
          htmlUrl: pr.html_url,
          githubCreatedAt: new Date(pr.created_at),
          githubUpdatedAt: new Date(pr.updated_at),
          mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
        },
        update: {
          title: pr.title,
          body: pr.body,
          state: mapPrState(pr),
          draft: pr.draft,
          authorLogin: pr.user?.login ?? "unknown",
          htmlUrl: pr.html_url,
          githubUpdatedAt: new Date(pr.updated_at),
          mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
        },
      });
    }

    // Actions "branch" filter is the run's head branch, not PR base — always fetch recent runs.
    let workflowSynced = 0;
    let failedRuns = 0;
    try {
      const runs = await listGithubWorkflowRuns(token, repository.owner, repository.name);
      for (const run of runs) {
        await prisma.workflowRun.upsert({
          where: {
            repositoryId_githubRunId: {
              repositoryId,
              githubRunId: String(run.id),
            },
          },
          create: {
            repositoryId,
            githubRunId: String(run.id),
            name: run.name,
            displayTitle: run.display_title ?? null,
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            branch: run.head_branch,
            htmlUrl: run.html_url,
            runNumber: run.run_number,
            githubCreatedAt: new Date(run.created_at),
            githubUpdatedAt: new Date(run.updated_at),
          },
          update: {
            name: run.name,
            displayTitle: run.display_title ?? null,
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            branch: run.head_branch,
            htmlUrl: run.html_url,
            runNumber: run.run_number,
            githubUpdatedAt: new Date(run.updated_at),
          },
        });
        if (run.conclusion === "failure" || run.conclusion === "timed_out") {
          failedRuns += 1;
        }
      }
      workflowSynced = runs.length;
    } catch (workflowErr) {
      console.error("Workflow sync failed", repositoryId, workflowErr);
    }

    await prisma.repository.update({
      where: { id: repositoryId },
      data: {
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });

    const hasActivity = pulls.length > 0 || workflowSynced > 0;
    if (!options.silent && hasActivity) {
      const branchNote = baseBranch ? ` → ${baseBranch}` : "";
      void notifyWorkspaceMembers({
        workspaceId: repository.workspaceId,
        type: "REPO_SYNCED",
        title: `Synced ${repository.fullName}${branchNote}`,
        body: `${pulls.length} pull request${pulls.length === 1 ? "" : "s"} · ${workflowSynced} Actions run${
          workflowSynced === 1 ? "" : "s"
        }`,
        link: "/app/pull-requests",
      });
    }

    if (!options.silent && failedRuns > 0) {
      void notifyWorkspaceMembers({
        workspaceId: repository.workspaceId,
        type: "WORKFLOW_FAILED",
        title: `CI failures in ${repository.fullName}`,
        body: `${failedRuns} recent workflow run(s) failed`,
        link: "/app/actions",
      });
    }

    return {
      synced: pulls.length,
      workflowRuns: workflowSynced,
      failedRuns,
      baseBranch: baseBranch ?? null,
      scanned,
      commonBases,
      notified: !options.silent && hasActivity,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { syncStatus: "ERROR", lastSyncError: message },
    });
    throw error;
  }
}

export function queueRepositorySync(repositoryId: string, options?: SyncOptions) {
  void import("../../jobs/sync.queue.js")
    .then(({ enqueueRepoSync }) => enqueueRepoSync(repositoryId, options))
    .catch((err) => {
      console.error("Failed to enqueue repo sync", repositoryId, err);
      setImmediate(() => {
        void syncRepositoryPullRequests(repositoryId, {
          silent: true,
          ...options,
        }).catch((syncErr) => {
          console.error("Repository sync failed", repositoryId, syncErr);
        });
      });
    });
}
