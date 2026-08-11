import { prisma } from "../../database/prisma.js";
import { decryptSecret } from "../../utils/crypto.js";
import { notifyWorkspaceMembers } from "../../realtime/socket.js";
import { listGithubPullRequests, type GithubPull } from "./github.client.js";

function mapPrState(pr: GithubPull) {
  if (pr.merged_at) return "MERGED" as const;
  if (pr.state === "closed") return "CLOSED" as const;
  return "OPEN" as const;
}

export async function syncRepositoryPullRequests(repositoryId: string) {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { connection: true },
  });
  if (!repository) throw new Error("Repository not found");

  await prisma.repository.update({
    where: { id: repositoryId },
    data: { syncStatus: "SYNCING", lastSyncError: null },
  });

  try {
    const token = decryptSecret(repository.connection.accessTokenEnc);
    const pulls = await listGithubPullRequests(token, repository.owner, repository.name);

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

    await prisma.repository.update({
      where: { id: repositoryId },
      data: {
        syncStatus: "SYNCED",
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });

    void notifyWorkspaceMembers({
      workspaceId: repository.workspaceId,
      type: "REPO_SYNCED",
      title: `Synced ${repository.fullName}`,
      body: `${pulls.length} pull request(s) imported`,
      link: "/app/pull-requests",
    });

    return { synced: pulls.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { syncStatus: "ERROR", lastSyncError: message },
    });
    throw error;
  }
}

export function queueRepositorySync(repositoryId: string) {
  setImmediate(() => {
    void syncRepositoryPullRequests(repositoryId).catch((err) => {
      console.error("Repository sync failed", repositoryId, err);
    });
  });
}
