# Background jobs (Redis + BullMQ)

Repo sync can run in the background via BullMQ when Redis is available.

## Setup

1. Run Redis locally (example):

```bash
docker run -d --name devflow-redis -p 6379:6379 redis:7-alpine
```

2. In `backend/.env`:

```
REDIS_URL=redis://127.0.0.1:6379
```

3. Restart the API. You should see:

```
Jobs: BullMQ repo-sync worker ready
```

If `REDIS_URL` is empty or Redis is down, DevFlow **falls back to inline** `setImmediate` sync — the app still works.

## What uses the queue

- Linking a repository (initial sync)
- GitHub webhook `push` / `create` / `delete` (refresh enqueue)
- Optional `POST /api/repositories/:id/sync` with `{ "background": true }`

Manual **Sync…** in the UI still runs **inline** so you get immediate counts + base-branch hints.

## Webhooks (polished)

`POST /api/webhooks/github` now handles:

| Event | Behavior |
|-------|----------|
| `pull_request` | Upsert PR immediately |
| `workflow_run` | Upsert Actions run; notify on failure |
| `push` / `create` / `delete` | Enqueue background repo sync |

Configure the webhook on GitHub to your API URL + `GITHUB_WEBHOOK_SECRET`.
