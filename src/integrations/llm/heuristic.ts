type IssueContext = {
  key: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  reporter: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
  pullRequests: Array<{ number: number; title: string; state: string }>;
};

type PrContext = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  author: string;
  repo: string;
  issue: { key: string; title: string; status: string } | null;
};

type CycleContext = {
  name: string;
  goal: string | null;
  status: string;
  progress: number;
  issueCount: number;
  doneCount: number;
  byStatus: Record<string, number>;
  blockers: Array<{ key: string; title: string; status: string; priority: string }>;
  recentTitles: string[];
};

type AskContext = {
  workspaceName: string;
  projects: Array<{ key: string; name: string; issueCount: number }>;
  openIssues: Array<{ key: string; title: string; status: string; priority: string }>;
  openPrs: Array<{ number: number; title: string; repo: string; state: string }>;
  activeCycles: Array<{ name: string; progress: number; issueCount: number }>;
};

function clip(text: string | null | undefined, max = 400) {
  if (!text) return "";
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function heuristicIssueSummary(ctx: IssueContext) {
  const lines = [
    `## Issue summary`,
    `**${ctx.key}** — ${ctx.title}`,
    ``,
    `- Status: ${ctx.status.replaceAll("_", " ")}`,
    `- Priority: ${ctx.priority}`,
    `- Reporter: ${ctx.reporter}`,
    `- Assignee: ${ctx.assignee ?? "Unassigned"}`,
  ];
  if (ctx.labels.length) lines.push(`- Labels: ${ctx.labels.join(", ")}`);
  if (ctx.description) {
    lines.push(``, `### What it is about`, clip(ctx.description, 600));
  }
  if (ctx.pullRequests.length) {
    lines.push(``, `### Linked pull requests`);
    for (const pr of ctx.pullRequests) {
      lines.push(`- #${pr.number} ${pr.title} (${pr.state})`);
    }
  } else {
    lines.push(``, `No linked pull requests yet.`);
  }
  if (ctx.comments.length) {
    lines.push(``, `### Recent discussion (${ctx.comments.length} comments)`);
    for (const c of ctx.comments.slice(-3)) {
      lines.push(`- ${c.author}: ${clip(c.body, 160)}`);
    }
  }
  lines.push(
    ``,
    `### Suggested next step`,
    ctx.status === "DONE"
      ? `This issue is done — confirm linked PRs are merged and close any leftover discussion.`
      : ctx.pullRequests.some((p) => p.state === "OPEN")
        ? `Review the open linked PR(s) and move the issue toward Done when merge is complete.`
        : `Clarify scope in the description/comments, then open or link a PR when work starts.`,
  );
  return lines.join("\n");
}

export function heuristicPrSummary(ctx: PrContext) {
  const lines = [
    `## Pull request summary`,
    `**#${ctx.number} ${ctx.title}** in \`${ctx.repo}\``,
    ``,
    `- State: ${ctx.state}${ctx.draft ? " (draft)" : ""}`,
    `- Author: ${ctx.author}`,
  ];
  if (ctx.body) {
    lines.push(``, `### What this PR appears to change`, clip(ctx.body, 700));
  } else {
    lines.push(
      ``,
      `### What this PR appears to change`,
      `No PR description was provided on GitHub. From the title alone: “${ctx.title}”.`,
      `Ask the author to add a short description of intent, risk, and test plan.`,
    );
  }
  if (ctx.issue) {
    lines.push(
      ``,
      `### Linked planning work`,
      `Tied to **${ctx.issue.key}** — ${ctx.issue.title} (status: ${ctx.issue.status.replaceAll("_", " ")}).`,
    );
  } else {
    lines.push(``, `Not linked to a DevFlow issue yet — link one so planning and review stay aligned.`);
  }
  lines.push(
    ``,
    `### Review focus`,
    `- Confirm the title/description match the intended change`,
    `- Check for missing tests or migration notes if this touches data/auth`,
    `- After merge, update the linked issue status`,
  );
  return lines.join("\n");
}

export function heuristicCycleSummary(ctx: CycleContext) {
  const lines = [
    `## Cycle delivery summary`,
    `**${ctx.name}** (${ctx.status})`,
    ``,
    ctx.goal ? `Goal: ${clip(ctx.goal, 300)}` : `No goal set.`,
    ``,
    `- Progress: ${ctx.progress}% (${ctx.doneCount}/${ctx.issueCount} done)`,
  ];
  const statusBits = Object.entries(ctx.byStatus)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s.replaceAll("_", " ")}: ${n}`);
  if (statusBits.length) lines.push(`- Breakdown: ${statusBits.join(" · ")}`);

  if (ctx.blockers.length) {
    lines.push(``, `### Needs attention`);
    for (const b of ctx.blockers.slice(0, 8)) {
      lines.push(
        `- ${b.key} ${b.title} — ${b.status.replaceAll("_", " ")} / ${b.priority}`,
      );
    }
  } else {
    lines.push(``, `No obvious blockers in IN_PROGRESS / IN_REVIEW.`);
  }

  if (ctx.recentTitles.length) {
    lines.push(``, `### Work in this cycle`);
    for (const t of ctx.recentTitles.slice(0, 10)) lines.push(`- ${t}`);
  }

  lines.push(
    ``,
    `### Takeaway`,
    ctx.progress >= 80
      ? `Cycle is nearly complete — focus on closing remaining review items.`
      : ctx.progress >= 40
        ? `Delivery is underway — watch IN_REVIEW items so they do not stall.`
        : `Early in the cycle — confirm priorities and assignment for high-priority issues.`,
  );
  return lines.join("\n");
}

export function heuristicAsk(question: string, ctx: AskContext) {
  const q = question.toLowerCase();
  const lines = [`## Answer`, ``];

  if (/pr|pull request|review/.test(q)) {
    if (!ctx.openPrs.length) {
      lines.push(`No open/synced pull requests in this workspace right now.`);
    } else {
      lines.push(`Here are the recent synced PRs:`);
      for (const pr of ctx.openPrs.slice(0, 8)) {
        lines.push(`- #${pr.number} ${pr.title} (\`${pr.repo}\`, ${pr.state})`);
      }
    }
  } else if (/cycle|sprint|delivery|progress/.test(q)) {
    if (!ctx.activeCycles.length) {
      lines.push(`No active cycles found. Create or activate a cycle to track delivery.`);
    } else {
      lines.push(`Active cycle snapshot:`);
      for (const c of ctx.activeCycles) {
        lines.push(`- ${c.name}: ${c.progress}% (${c.issueCount} issues)`);
      }
    }
  } else if (/blocker|stuck|urgent|priority/.test(q)) {
    const urgent = ctx.openIssues.filter((i) =>
      ["URGENT", "HIGH"].includes(i.priority),
    );
    if (!urgent.length) {
      lines.push(`No high/urgent open issues flagged right now.`);
    } else {
      lines.push(`Higher-priority open issues:`);
      for (const i of urgent.slice(0, 8)) {
        lines.push(`- ${i.key} ${i.title} (${i.status.replaceAll("_", " ")})`);
      }
    }
  } else if (/issue|task|todo|work/.test(q)) {
    lines.push(`Open issues in **${ctx.workspaceName}**:`);
    for (const i of ctx.openIssues.slice(0, 10)) {
      lines.push(`- ${i.key} ${i.title} — ${i.status.replaceAll("_", " ")}`);
    }
    if (!ctx.openIssues.length) lines.push(`No open issues found.`);
  } else {
    lines.push(
      `Based on workspace **${ctx.workspaceName}**:`,
      `- Projects: ${ctx.projects.map((p) => p.key).join(", ") || "none"}`,
      `- Open issues: ${ctx.openIssues.length}`,
      `- Synced PRs (sample): ${ctx.openPrs.length}`,
      `- Active cycles: ${ctx.activeCycles.length}`,
      ``,
      `Try asking about open PRs, cycle progress, blockers, or specific issue titles.`,
    );
  }

  lines.push(
    ``,
    `_Generated from your DevFlow workspace data only (no external repo clone)._`,
  );
  return lines.join("\n");
}

export type { IssueContext, PrContext, CycleContext, AskContext };
