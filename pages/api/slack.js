import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

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
    allDatedTodayOrOverdue: [],
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
      if (dueDate <= today) buckets.allDatedTodayOrOverdue.push(task);
    }
  }

  return buckets;
}

function inferDomain(task) {
  const labels = (task.labels || []).map((l) => String(l).toLowerCase());
  const content = String(task.content || "").toLowerCase();

  const workHints = [
    "professional",
    "client",
    "product",
    "project",
    "boss",
    "meeting",
    "demo",
    "launch",
    "delivery",
    "engineering",
    "design",
    "analytics",
    "hypothesis",
    "research",
    "testing",
    "stakeholder",
  ];

  const spiritualHints = ["spiritual", "pray", "bible", "church", "scripture"];
  const healthHints = ["health", "exercise", "gym", "walk", "sleep", "workout"];
  const relationshipHints = ["relationship", "friend", "family", "call", "check in"];
  const personalHints = ["personal", "home", "errand", "outfit", "shopping", "plan"];

  const matches = (hints) =>
    hints.some((hint) => labels.includes(hint) || content.includes(hint));

  if (matches(workHints)) return "work";
  if (matches(spiritualHints)) return "spiritual";
  if (matches(healthHints)) return "health";
  if (matches(relationshipHints)) return "relationship";
  if (matches(personalHints)) return "personal";
  return "unclear";
}

function summariseTaskForModel(task) {
  return {
    content: task.content,
    due: task.due?.date || null,
    labels: task.labels || [],
    priority: task.priority || 1,
    domain: inferDomain(task),
  };
}

function buildAgentPayload(tasks, buckets) {
  const highSignal = [
    ...buckets.dueToday.slice(0, 20),
    ...buckets.overdue.slice(0, 20),
    ...buckets.blocked.slice(0, 20),
    ...buckets.waiting.slice(0, 20),
    ...buckets.updates.slice(0, 20),
  ];

  const seen = new Set();
  const deduped = [];

  for (const task of highSignal) {
    const key = `${task.content}__${task.due?.date || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(task);
    }
  }

  const domains = {
    work: 0,
    personal: 0,
    spiritual: 0,
    health: 0,
    relationship: 0,
    unclear: 0,
  };

  for (const task of deduped) {
    const domain = inferDomain(task);
    domains[domain] = (domains[domain] || 0) + 1;
  }

  return {
    counts: {
      totalTasksFetched: tasks.length,
      overdue: buckets.overdue.length,
      dueToday: buckets.dueToday.length,
      blocked: buckets.blocked.length,
      waiting: buckets.waiting.length,
      updates: buckets.updates.length,
    },
    domainCountsFromHighSignal: domains,
    tasks: deduped.map(summariseTaskForModel),
  };
}

function formatSimpleSection(title, tasks, emoji = "📌") {
  if (!tasks.length) {
    return `${emoji} *${title}*\n_Absolutely nothing obvious here._`;
  }

  const top = tasks.slice(0, 8);

  return (
    `${emoji} *${title}*\n\n` +
    top
      .map((t, i) => {
        const due = t.due?.date ? `\n   🗓️ Due: ${formatHumanDate(t.due.date)}` : "";
        const labels = t.labels?.length ? `\n   🏷️ ${t.labels.join(", ")}` : "";
        return `*${i + 1}.* ${t.content}${due}${labels}`;
      })
      .join("\n\n")
  );
}

function fallbackDeterministicReply(question, buckets) {
  const q = question.toLowerCase();

  if (
    q.includes("today") ||
    q.includes("lineup") ||
    q.includes("what do we have") ||
    q.includes("what's up today") ||
    q.includes("whats up today") ||
    q.includes("what's going on today") ||
    q.includes("whats going on today")
  ) {
    return formatSimpleSection("Today’s lineup", [...buckets.dueToday, ...buckets.overdue.slice(0, 5)], "🗓️");
  }

  if (
    q.includes("follow up") ||
    q.includes("follow-up") ||
    q.includes("followups") ||
    q.includes("follow ups") ||
    q.includes("chase") ||
    q.includes("waiting")
  ) {
    return formatSimpleSection("Follow-ups", [...buckets.waiting, ...buckets.overdue.slice(0, 5)], "📨");
  }

  if (
    q.includes("priority") ||
    q.includes("priorities") ||
    q.includes("focus") ||
    q.includes("urgent") ||
    q.includes("matters most") ||
    q.includes("overdue")
  ) {
    return formatSimpleSection("Priority stack", [...buckets.dueToday, ...buckets.overdue.slice(0, 8)], "🔥");
  }

  if (q.includes("boss") || q.includes("update")) {
    return formatSimpleSection("Boss update inputs", buckets.updates, "📣");
  }

  return [
    "🤔 *I’m not fully sure from fallback logic alone.*",
    "I can answer best when you ask about:",
    "• today / lineup",
    "• follow-ups / who to chase",
    "• priorities / overdue",
    "• what to tell boss",
  ].join("\n");
}

function safeArray(value, max = 6) {
  return Array.isArray(value) ? value.slice(0, max).map((v) => String(v).trim()).filter(Boolean) : [];
}

function parseStructuredModelResponse(text) {
  let cleaned = String(text || "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }

  const parsed = JSON.parse(cleaned);

  return {
    lens: String(parsed.lens || "general").trim(),
    opening: String(parsed.opening || "").trim(),
    bullets: safeArray(parsed.bullets, 6),
    next_moves: safeArray(parsed.next_moves, 3),
    confidence_note: String(parsed.confidence_note || "").trim(),
  };
}

function renderStructuredSlackText(data) {
  const emojiMap = {
    general: "🧭",
    today: "🗓️",
    followup: "📨",
    priorities: "🔥",
    work: "💼",
    boss: "📣",
    risk: "🚨",
    balance: "⚖️",
  };

  const emoji = emojiMap[data.lens] || "🧠";
  const parts = [];

  if (data.opening) {
    parts.push(`${emoji} *${data.opening}*`);
  }

  if (data.bullets.length) {
    parts.push(data.bullets.map((b) => `• ${b}`).join("\n"));
  }

  if (data.next_moves.length) {
    parts.push(`*Next move:*\n${data.next_moves.map((m, i) => `${i + 1}. ${m}`).join("\n")}`);
  }

  if (data.confidence_note) {
    parts.push(`_${data.confidence_note}_`);
  }

  return parts.join("\n\n").trim() || "🤔 I couldn't build a reliable answer.";
}

async function callOpenRouter(question, payload) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is missing");
  }

  const systemPrompt = [
    "You are a sharp execution assistant across work and personal life.",
    "Truth over polish. Accuracy over service.",
    "Use ONLY the provided Todoist snapshot and the user's question.",
    "Do not invent owners, meetings, blockers, urgency, progress, or external facts.",
    "If the data does not support a claim, say so clearly.",
    "You must self-check your answer against the provided counts and task list before responding.",
    "The task set can include work, personal, spiritual, health, and relationship items. All are valid.",
    "Infer the lens of the question before answering.",
    "If the user asks broad daily questions, answer across life and work.",
    "If the user asks work-specific questions like what to tell boss, bias toward professional items.",
    "If the user asks about follow-ups, prioritise waiting, stalled, or overdue items that look follow-up-worthy.",
    "If the user asks about priorities or overdue items, weigh urgency, due dates, backlog pressure, and domain balance.",
    "If the data is noisy, say that briefly but still give the best grounded answer you can.",
    "Return STRICT JSON ONLY. No markdown. No code fences. No commentary outside JSON.",
    "JSON schema:",
    "{",
    '  "lens": "one of: today, followup, priorities, work, boss, risk, balance, general",',
    '  "opening": "short one-line summary",',
    '  "bullets": ["3 to 6 concise bullets"],',
    '  "next_moves": ["0 to 3 concrete next moves"],',
    '  "confidence_note": "brief uncertainty note only if needed, else empty string"',
    "}",
  ].join(" ");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://vercel.app",
      "X-OpenRouter-Title": "Todoist Execution Agent",
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
            `User question:\n${question}\n\n` +
            `Todoist snapshot:\n${JSON.stringify(payload, null, 2)}`
        }
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter request failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content || "";

  return parseStructuredModelResponse(content);
}

async function slackApi(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!body.ok) {
    throw new Error(`Slack ${method} failed: ${JSON.stringify(body)}`);
  }

  return body;
}

async function addReaction(channel, timestamp, name) {
  try {
    await slackApi("reactions.add", {
      channel,
      timestamp,
      name,
    });
  } catch (err) {
    console.error("addReaction failed:", err.message);
  }
}

async function removeReaction(channel, timestamp, name) {
  try {
    await slackApi("reactions.remove", {
      channel,
      timestamp,
      name,
    });
  } catch (err) {
    console.error("removeReaction failed:", err.message);
  }
}

async function postToSlack(payload) {
  return slackApi("chat.postMessage", payload);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function processMention(event) {
  const userText = (event.text || "").replace(/<@[^>]+>/g, "").trim();
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  const sourceTs = event.ts;

  await addReaction(channel, sourceTs, "eyes");

  try {
    const todoistRes = await fetch("https://api.todoist.com/api/v1/tasks?limit=200", {
      headers: {
        Authorization: `Bearer ${process.env.TODOIST_TOKEN}`,
      },
    });

    if (!todoistRes.ok) {
      await postToSlack({
        channel,
        thread_ts,
        text: `⚠️ *I couldn't load Todoist properly.*\nStatus: ${todoistRes.status}`,
      });
      await removeReaction(channel, sourceTs, "eyes");
      await addReaction(channel, sourceTs, "warning");
      return;
    }

    const todoistBody = await todoistRes.json();
    const tasks = Array.isArray(todoistBody.results) ? todoistBody.results : [];
    const buckets = bucketTasks(tasks);
    const payload = buildAgentPayload(tasks, buckets);

    let reply;
    try {
      const structured = await callOpenRouter(userText, payload);
      reply = renderStructuredSlackText(structured);
    } catch (err) {
      reply =
        `⚠️ *Model answer unavailable right now.*\n` +
        `Reason: ${err.message}\n\n` +
        fallbackDeterministicReply(userText, buckets);
    }

    await postToSlack({
      channel,
      thread_ts,
      text: reply,
    });

    await removeReaction(channel, sourceTs, "eyes");
    await addReaction(channel, sourceTs, "white_check_mark");
  } catch (err) {
    console.error("processMention failed:", err);

    try {
      await postToSlack({
        channel,
        thread_ts,
        text: `⚠️ *Something went wrong while processing that.*\nI couldn't complete it reliably.`,
      });
    } catch (postErr) {
      console.error("postToSlack after failure failed:", postErr);
    }

    await removeReaction(channel, sourceTs, "eyes");
    await addReaction(channel, sourceTs, "warning");
  }
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

  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).send("ok");
  }

  if (body.type === "event_callback" && body.event?.type === "app_mention") {
    const event = body.event;

    if (event.bot_id) {
      return res.status(200).send("ok");
    }

    res.status(200).send("ok");

    waitUntil(
      processMention(event).catch((err) => {
        console.error("waitUntil processMention failed:", err);
      })
    );
    return;
  }

  return res.status(200).send("ok");
}
