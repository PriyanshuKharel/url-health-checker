# Loom script — Bulk URL Health Checker

Target length: **4 to 4.5 minutes**. Read the lines out loud once before recording so they sound natural.

`DO` = what to click or show. `SAY` = what to say.

---

## Before you press record

```bash
cd c:\Users\lenovo\Desktop\task
docker compose down -v
docker compose up --build
```

Wait until the API replicas report healthy. Then set up:

- **Browser tab 1** — http://localhost:3000
- **Browser tab 2** — http://localhost:4100/stats
- **Terminal window** — `docker compose logs -f worker`
- Have `Desktop\demo-urls.csv` ready
- Turn off notifications

Reset the counter right before you record: `curl http://localhost:4100/reset`

---

## 0:00 — What it is (20 seconds)

`DO` Show the home page.

`SAY`

> Hi, I am Priyanshu. This is my bulk URL health checker.
>
> You give it a list of URLs. It checks each one in the background. It saves the status code, the response time, and the page title. The page updates live as the results arrive.
>
> It runs with one command: docker compose up. That starts two API servers and two worker processes. I will show you why two matters.

---

## 0:20 — Submit a CSV (30 seconds)

`DO` Click **Upload CSV**, pick `demo-urls.csv`, show the box filling with URLs, click **Check URLs**.

`SAY`

> Let me upload a CSV. This file has 24 real websites. It also has extra columns, so the app picks out the URL column and ignores the rest.
>
> Now I press Check URLs.
>
> Two things just happened. First, the batch and all 24 URLs were saved to Postgres. Only after that were the jobs added to the queue. That order is important. If the app crashed in between, I would never have jobs running for a batch that does not exist.
>
> Second, I am now on the batch page, and it has its own URL. I can share this link, or open it tomorrow.

---

## 0:50 — Live progress and architecture (50 seconds)

`DO` Let the rows fill in. Do not click anything.

`SAY`

> I am not clicking anything now. Each row updates by itself.
>
> There are three programs here. Next.js serves the pages. Fastify is the API. And the workers are a completely separate process, so slow checking never makes the website slow.
>
> They share two things. Postgres is the source of truth. It holds every batch and every result. The progress numbers are counted from the rows every time, never stored as a total, so they cannot go out of step.
>
> Redis does four jobs. It stores the queue for BullMQ. It holds the rate limit. It broadcasts every result to the API servers. And it holds the thirty second cache for the batch list.
>
> Without Redis, three of the requirements break the moment I start a second process. That is why it is in the design.

---

## 1:40 — Read the results (45 seconds)

`DO` Point at the rows as you talk.

`SAY`

> It is finished. These are real page titles, pulled out of the HTML.
>
> Now look at this row. This GitHub page returns 404. Its state is completed, not failed. That is deliberate. The check worked. The answer was 404.
>
> These rows are different. This one has an expired certificate. This one is a host that does not exist. These are failed. And look at the attempts column: one attempt only. Retrying a broken certificate will never help, so I do not retry it.
>
> These last two are a server error. They were retried three times, waiting one, two, and four seconds. Then they failed. So: three retries with growing delays, but only for errors that might fix themselves.

---

## 2:25 — Refresh, cancel, retry (40 seconds)

`DO` Reload the page.

`SAY`

> Let me refresh. Everything is still correct, because nothing is kept in the browser. The page is built on the server from Postgres.

`DO` Go home, click **Fill with demo URLs**, submit, then click **Cancel batch** after a few seconds. Point at the terminal log line.

`SAY`

> Now a new batch, and I cancel it while it is running.
>
> Some requests were already sent. I cannot un-send them. So when their answers come back, the database refuses them. Every result write says: save this only if this row is still running. A cancelled row fails that test.

`DO` Open the first batch, click **Retry failed only**.

`SAY`

> And retry failed only re-runs the failed rows. The successful ones are never touched.

---

## 3:05 — Prove the limits (40 seconds)

`DO` Switch to the `/stats` tab and refresh it.

`SAY`

> Now the part I care most about. The rules are ten requests per second for the whole system, and five checks at the same time. Not ten per worker. Ten in total.
>
> Most queue libraries only limit per process. Two workers would give me twenty per second. So the limit lives in Redis, and every worker draws from one budget. Before any request goes out, the worker takes a permit and a token.
>
> This page is a small server I wrote that counts what it actually receives. With two workers running, the highest it saw was ten requests in a second, and five at the same time.
>
> I check this three ways: from the target's side, from the database timestamps, and with a stress test on the limiter alone.

---

## 3:45 — Live updates (30 seconds)

`SAY`

> For live updates I chose Server-Sent Events. The data only travels one way, from server to browser, so I do not need WebSockets. And the browser reconnects on its own.
>
> The hard part is having two API servers. Your browser is attached to one of them, but the result comes from a worker. So the worker publishes every change to a Redis channel, every API server listens, and passes it on. It does not matter which server you are on.
>
> The stream only sends changes and never replays them. Instead, every time the connection opens, the browser asks for the full state again. So a dropped connection repairs itself with one request.

---

## 4:15 — Idempotency and trade-offs (25 seconds)

`SAY`

> One last thing: idempotency. If you submit and the network loses the reply, your browser may send it again. Every submission carries a key, and the same key always returns the same batch. You never get a duplicate.
>
> Trade-offs for time. I run TypeScript directly instead of compiling it. I wrote the SQL by hand instead of using an ORM, because I wanted the transactions to be obvious. And I did not write an automated test suite — that time went into proving the limits instead. With more time, integration tests against this Docker setup would be first.
>
> All my assumptions are written in the README. Thank you for watching.

---

## If you are running over time

Cut in this order:

1. The **Retry failed only** click (say it instead of showing it).
2. The refresh demo.
3. Shorten the architecture section to Postgres and Redis only.

Never cut: the limits proof, the SSE explanation, and the trade-offs. Those are three of the five things the brief asks the video to cover.
