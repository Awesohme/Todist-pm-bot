import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function formatOrdinal(day) {
  if (day >= 11 && day <= 13) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

function formatHumanDate(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);

  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const month = date.toLocaleDateString("en-GB", { month: "long" });
  const day = date.getDate();
  const year = date.getFullYear();

  return `${weekday}, ${formatOrdinal(day)} of ${month}, ${year}`;
}

function bucketTasks(tasks) {
  const today = new Date().toISOString().slice(0, 10);

  const buckets = {
    overdue: [],
    dueToday: [],
    blocked: [],
    waiting: [],
    updates: [],
  };

  for (const task of tasks) {
    const labels = task.labels || [];
    const dueDate = task.due?.date ? String(task.due.date).slice(0, 10) : null;

    if (labels.includes("blocked")) buckets.blocked.push(task);
    if (labels.includes("waiting")) buckets.waiting.push(task);
    if (labels.includes("update")) buckets.updates.push(task);

    if (dueDate) {
      if (dueDate < today) buckets.overdue.push(task);
      if (dueDate === today) buckets.dueToday.push(task);
    }
  }

  return buckets;
}

function summariseTask(task) {
  return {
    content: task.content,
    due: task.due?.date || null,
    labels: task.labels || [],
    priority: task.priority || 1,
  };
}

function buildAgentPayload(tasks, buckets) {
  const important = [
    ...buckets.overdue.slice(0, 12),
    ...buckets.dueToday.slice(0, 12),
    ...buckets.blocked.slice(0, 12),
    ...buckets.waiting.slice(0, 12),
    ...buckets.updates.slice(0, 12),
  ];

  const seen = new Set();
  const deduped = [];

  for (const task of important) {
    const key = `${task.content}__${task.due?.date || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(task);
    }
  }

  return {
    counts: {
      overdue: buckets.overdue.length,
      dueToday: buckets.dueToday.length,
      blocked: buckets.blocked.length,
      waiting: buckets.waiting.length,
      updates: buckets.updates.length,
    },
    tasks: deduped.map(summariseTask),
  };
}

async function callOpenRouter(userMessage, payload) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is missing");
  }

  const systemPrompt = [
    "You are a sharp PM assistant inside Slack.",
    "Truth over polish. Accuracy over service.",
    "Use ONLY the provided Todoist snapshot and the user's message.",
    "If the data does not support a claim, say you do not know or cannot verify it from the current task data.",
    "Do not invent owners, blockers, meetings, progress, or priorities that are not in the snapshot.",
    "Double-check your own claims against the provided counts and task list before answering.",
    "Do not output multiple alternative answers. Give one final answer only.",
    "Keep the format Slack-friendly, clean, and compact.",
    "Preferred structure:",
    "- one short opening line",
    "- then 3 to 6 bullets max",
    "- if useful, end with 'Next move:' and 1 to 3 actions",
    "If the user asks about follow-ups, priorities, today, risks, what to tell boss, or what matters now, answer directly from the snapshot.",
    "If the snapshot is noisy or includes personal tasks, say that briefly and still give the best answer you can.",
  ].join(" ");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://vercel.app",
      "X-OpenRouter-Title": "Todoist PM Agent",
    },
    body: JSON.stringify({
      model: "openrouter/free",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content:
            `User asked:\n${userMessage}\n\n` +
            `Todoist snapshot:\n${JSON.stringify(payload, null, 2)}`
        }
      ],
      temperature: 0.15,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter request failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  return body?.choices?.[0]?.message?.content || "I couldn't produce a reliable answer.";
}

async function postToSlack(payload) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!body.ok) {
    throw new Error(`Slack post failed: ${JSON.stringify(body)}`);
  }

  return body;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function processMention(event) {
  const userText = (event.text || "").trim();
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;

  const todoistRes = await fetch("https://api.todoist.com/api/v1/tasks?limit=200", {
    headers: {
      Authorization: `Bearer ${process.env.TODOIST_TOKEN}`,
    },
  });

  if (!todoistRes.ok) {
    await postToSlack({
      channel,
      thread_ts,
      text: `⚠️ Todoist fetch failed: ${todoistRes.status}`,
    });
    return;
  }

  const todoistBody = await todoistRes.json();
  const tasks = Array.isArray(todoistBody.results) ? todoistBody.results : [];
  const buckets = bucketTasks(tasks);
  const payload = buildAgentPayload(tasks, buckets);

  let reply;
  try {
    reply = await callOpenRouter(userText, payload);
  } catch (err) {
    reply = `⚠️ I couldn’t answer that reliably.\n${err.message}`;
  }

  await postToSlack({
    channel,
    thread_ts,
    text: reply,
  });
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("Vercel Slack handler is live");
  }

  const rawBody = await readRawBody(req);

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];

  if (!timestamp || !slackSignature) {
    return res.status(400).send("Missing Slack signature headers");
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) {
    return res.status(400).send("Stale request");
  }

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(sigBase)
      .digest("hex");

  if (!timingSafeEqual(computed, slackSignature)) {
    return res.status(401).send("Invalid signature");
  }

  const body = JSON.parse(rawBody || "{}");

  if (body.type === "url_verification" && body.challenge) {
    return res.status(200).send(body.challenge);
  }

  // Ignore Slack retries to prevent duplicate thread replies
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).send("ok");
  }

  if (body.type === "event_callback" && body.event?.type === "app_mention") {
    const event = body.event;

    if (event.bot_id) {
      return res.status(200).send("ok");
    }

    // Ack immediately so Slack doesn't retry while we wait on Todoist / OpenRouter
    res.status(200).send("ok");

    processMention(event).catch((err) => {
      console.error("processMention failed:", err);
    });
    return;
  }

  return res.status(200).send("ok");
}
