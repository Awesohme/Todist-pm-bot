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

function formatReply(title, tasks) {
  const emojiMap = {
    overdue: "🚨",
    today: "⏰",
    blocked: "🧱",
    waiting: "🕒",
    updates: "📣",
  };

  const emoji = emojiMap[title] || "•";

  if (!tasks.length) {
    return `${emoji} *${title}*\n_Absolutely nothing here._`;
  }

  return (
    `${emoji} *${title}* — *${tasks.length} item${tasks.length === 1 ? "" : "s"}*\n\n` +
    tasks.map((t, i) => {
      const due = t.due?.date ? `\n   🗓️ Due: ${formatHumanDate(t.due.date)}` : "";
      const labels = t.labels?.length ? `\n   🏷️ ${t.labels.join(", ")}` : "";
      return `*${i + 1}.* ${t.content}${due}${labels}`;
    }).join("\n\n")
  );
}

function summariseTaskForModel(task) {
  return {
    content: task.content,
    due: task.due?.date || null,
    labels: task.labels || [],
    priority: task.priority || 1,
  };
}

function buildBriefPayload(buckets) {
  const important = [
    ...buckets.overdue.slice(0, 10),
    ...buckets.dueToday.slice(0, 10),
    ...buckets.blocked.slice(0, 10),
    ...buckets.waiting.slice(0, 10),
    ...buckets.updates.slice(0, 10),
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
    tasks: deduped.map(summariseTaskForModel),
  };
}

async function callOpenRouterBrief(payload) {
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
          content:
            "You are a sharp PM assistant. Be concise, direct, and practical. " +
            "Given task data, return a Slack-friendly briefing with these headings only: " +
            "1) Top risks, 2) What to chase today, 3) What to tell boss, 4) Suggested next 3 actions. " +
            "Do not waffle. Prefer prioritisation over listing everything."
        },
        {
          role: "user",
          content:
            "Create a concise PM briefing from this Todoist snapshot.\n\n" +
            JSON.stringify(payload, null, 2)
        }
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter request failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  return body?.choices?.[0]?.message?.content || "No model response.";
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

  if (body.type === "event_callback" && body.event?.type === "app_mention") {
    const event = body.event;

    if (event.bot_id) {
      return res.status(200).send("ok");
    }

    const text = (event.text || "").toLowerCase();
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
      return res.status(200).send("ok");
    }

    const todoistBody = await todoistRes.json();
    const tasks = Array.isArray(todoistBody.results) ? todoistBody.results : [];
    const buckets = bucketTasks(tasks);

    let reply = "I heard you. Try: overdue, today, blocked, waiting, updates, or brief me.";

    if (text.includes("brief me")) {
      try {
        const payload = buildBriefPayload(buckets);
        reply = await callOpenRouterBrief(payload);
      } catch (err) {
        reply = `⚠️ Briefing failed.\n${err.message}`;
      }
    } else if (text.includes("overdue")) {
      reply = formatReply("overdue", buckets.overdue);
    } else if (text.includes("today")) {
      reply = formatReply("today", buckets.dueToday);
    } else if (text.includes("blocked")) {
      reply = formatReply("blocked", buckets.blocked);
    } else if (text.includes("waiting")) {
      reply = formatReply("waiting", buckets.waiting);
    } else if (text.includes("update")) {
      reply = formatReply("updates", buckets.updates);
    }

    await postToSlack({
      channel,
      thread_ts,
      text: reply,
    });

    return res.status(200).send("ok");
  }

  return res.status(200).send("ok");
}
