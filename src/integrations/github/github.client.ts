import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";

const GITHUB_API = "https://api.github.com";

type GithubUser = { id: number; login: string };
type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: { login: string };
};
type GithubPull = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  html_url: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
};

async function githubFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "DevFlow-AI",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(`GitHub API error (${res.status}): ${text.slice(0, 200)}`, 502, "GITHUB_API_ERROR");
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function assertGithubConfigured() {
  if (!env.githubConfigured) {
    throw new AppError(
      "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
      503,
      "GITHUB_NOT_CONFIGURED",
    );
  }
}

export async function exchangeGithubCode(code: string) {
  assertGithubConfigured();
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_CALLBACK_URL,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new AppError(
      data.error_description || data.error || "Failed to exchange GitHub code",
      400,
      "GITHUB_OAUTH_ERROR",
    );
  }
  return { accessToken: data.access_token, scope: data.scope ?? "" };
}

export async function fetchGithubUser(token: string) {
  return githubFetch<GithubUser>("/user", token);
}

export async function listGithubRepos(token: string) {
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await githubFetch<GithubRepo[]>(
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      token,
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

export async function listGithubPullRequests(token: string, owner: string, repo: string) {
  const pulls: GithubPull[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await githubFetch<GithubPull[]>(
      `/repos/${owner}/${repo}/pulls?state=all&per_page=50&page=${page}&sort=updated&direction=desc`,
      token,
    );
    pulls.push(...batch);
    if (batch.length < 50) break;
  }
  return pulls;
}

type GithubWorkflowRun = {
  id: number;
  name: string;
  display_title?: string;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  html_url: string;
  run_number: number;
  created_at: string;
  updated_at: string;
};

export async function listGithubWorkflowRuns(token: string, owner: string, repo: string) {
  const data = await githubFetch<{ workflow_runs: GithubWorkflowRun[] }>(
    `/repos/${owner}/${repo}/actions/runs?per_page=30`,
    token,
  );
  return data.workflow_runs ?? [];
}

export type { GithubPull, GithubRepo, GithubWorkflowRun };
