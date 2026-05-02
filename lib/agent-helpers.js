import crypto from "crypto";

export const REMINDER_CONFIG_KEY = "agent:reminder_config:v1";
export const REMINDER_STATE_KEY = "agent:reminder_state:v1";

export const DEFAULT_REMINDER_CONFIG = {
  reminders_enabled: true,
  snoozed_until: null,
  enable_t2h: true,
  enable_t1h: true,
  enable_t30m: true,
  max_alerts_per_run: 3,
  mode: "all",
  slack_user_id: null
};

export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function verifySlackSignature(req, rawBody, signingSecret) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];

  if (!timestamp || !slackSignature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBase)
      .digest("hex");

  const aBuf = Buffer.from(computed);
  const bBuf = Buffer.from(slackSignature);
  if (aBuf.length !== bBuf.length) return false;

  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function parseSlackForm(rawBody) {
  const params = new URLSearchParams(rawBody);
  return Object.fromEntries(params.entries());
}

export async function slackApi(method, payload) {
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

export async function postToSlack(payload) {
  return slackApi("chat.postMessage", payload);
}

export function formatOrdinal(day) {
  if (day >= 11 && day <= 13) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

export function formatHumanDate(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);

  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const month = date.toLocaleDateString("en-GB", { month: "long" });
  const day = date.getDate();
  const year = date.getFullYear();

  return `${weekday}, ${formatOrdinal(day)} of ${month}, ${year}`;
}

export async function fetchTodoistTasks() {
  const res = await fetch("https://api.todoist.com/api/v1/tasks?limit=200", {
    headers: {
      Authorization: `Bearer ${process.env.TODOIST_TOKEN}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Todoist fetch failed: ${res.status}`);
  }

  const body = await res.json();
  return Array.isArray(body.results) ? body.results : [];
}

export function bucketTasks(tasks) {
  const today = new Date().toISOString().slice(0, 10);

  const buckets = {
    overdue: [],
    dueToday: [],
    blocked: [],
    waiting: [],
    updates: [],
  };

  for (const task of tasks) {
    const labels = (task.labels || []).map((x) => String(x).toLowerCase());
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

export function formatSimpleSection(title, tasks, emoji = "📌") {
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

export function quickTodayReply(buckets) {
  return formatSimpleSection(
    "Today’s lineup",
    [...buckets.dueToday, ...buckets.overdue.slice(0, 5)],
    "🗓️"
  );
}

export function quickFollowupsReply(buckets) {
  return formatSimpleSection(
    "Follow-ups",
    [...buckets.waiting, ...buckets.overdue.slice(0, 5)],
    "📨"
  );
}

export function quickPrioritiesReply(buckets) {
  return formatSimpleSection(
    "Priority stack",
    [...buckets.dueToday, ...buckets.overdue.slice(0, 8)],
    "🔥"
  );
}

export async function upstashGetJSON(key, fallbackValue) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Upstash GET failed: ${res.status}`);
  }

  const body = await res.json();
  if (body.result == null) return fallbackValue;

  if (typeof body.result === "string") {
    try {
      return JSON.parse(body.result);
    } catch {
      return fallbackValue;
    }
  }

  return body.result;
}

export async function upstashSetJSON(key, value) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });

  if (!res.ok) {
    throw new Error(`Upstash SET failed: ${res.status}`);
  }

  return res.json();
}

export async function getReminderConfig() {
  return upstashGetJSON(REMINDER_CONFIG_KEY, DEFAULT_REMINDER_CONFIG);
}

export async function saveReminderConfig(config) {
  return upstashSetJSON(REMINDER_CONFIG_KEY, config);
}

export async function getReminderState() {
  return upstashGetJSON(REMINDER_STATE_KEY, {});
}

export async function saveReminderState(state) {
  return upstashSetJSON(REMINDER_STATE_KEY, state);
}

export function fingerprintTask(task) {
  const labels = [...(task.labels || [])].sort();
  return JSON.stringify({
    content: task.content || "",
    due: task.due?.datetime || task.due?.date || null,
    labels,
    priority: task.priority || 1,
    description: task.description || "",
    section_id: task.section_id || null
  });
}

export function getTimedDueDate(task) {
  const raw = task.due?.datetime || task.due?.date || null;
  if (!raw) return null;

  // date-only tasks are not suitable for T-2h / T-1h / T-30m reminders
  if (typeof raw === "string" && !raw.includes("T")) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function parseSnoozeInput(text) {
  const match = text.match(/snooze\s+(\d+)\s*(m|h|d|minute|minutes|hour|hours|day|days)/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  let ms = 0;
  if (unit.startsWith("m")) ms = amount * 60 * 1000;
  else if (unit.startsWith("h")) ms = amount * 60 * 60 * 1000;
  else if (unit.startsWith("d")) ms = amount * 24 * 60 * 60 * 1000;

  return ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
}
