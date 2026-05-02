import {
  fetchTodoistTasks,
  getReminderConfig,
  getReminderState,
  saveReminderState,
  fingerprintTask,
  getTimedDueDate,
  postToSlack,
  formatHumanDate
} from "../../lib/agent-helpers.js";

function stageLabel(stage) {
  if (stage === "first") return "T-2h / first pass in window";
  if (stage === "second") return "T-1h";
  if (stage === "third") return "T-30m";
  return "unknown";
}

function formatMinutes(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function isBlockedOrWaiting(task) {
  const labels = (task.labels || []).map((x) => String(x).toLowerCase());
  return labels.includes("blocked") || labels.includes("waiting");
}

function shouldSkipByConfig(config) {
  if (!config.reminders_enabled) return "Reminders are paused.";
  if (config.snoozed_until) {
    const snoozedUntil = new Date(config.snoozed_until);
    if (!Number.isNaN(snoozedUntil.getTime()) && snoozedUntil > new Date()) {
      return `Reminders are snoozed until ${config.snoozed_until}.`;
    }
  }
  return null;
}

export default async function handler(req, res) {
  const secret = req.query.secret || req.headers["x-hourly-job-secret"];

  if (!secret || secret !== process.env.HOURLY_JOB_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const config = await getReminderConfig();
  const skipReason = shouldSkipByConfig(config);

  if (skipReason) {
    return res.status(200).json({ ok: true, skipped: skipReason });
  }

  if (!config.slack_user_id) {
    return res.status(200).json({
      ok: true,
      skipped: "No slack_user_id saved yet. Run a slash command like /agent settings first."
    });
  }

  const tasks = await fetchTodoistTasks();
  const state = await getReminderState();
  const newState = { ...state };

  const now = new Date();
  const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const activeTaskIds = new Set();
  const alerts = [];

  for (const task of tasks) {
    activeTaskIds.add(String(task.id));

    if (isBlockedOrWaiting(task)) continue;

    const due = getTimedDueDate(task);
    if (!due) continue;
    if (due <= now) continue;
    if (due > twoHoursFromNow) continue;

    const taskId = String(task.id);
    const fingerprint = fingerprintTask(task);
    const dueIso = due.toISOString();
    const timeLeftMs = due.getTime() - now.getTime();

    let entry = newState[taskId] || {
      fingerprint: null,
      last_seen_due: null,
      first_sent_at: null,
      second_sent_at: null,
      third_sent_at: null
    };

    const changed =
      entry.fingerprint !== fingerprint ||
      entry.last_seen_due !== dueIso;

    if (changed) {
      entry = {
        fingerprint,
        last_seen_due: dueIso,
        first_sent_at: null,
        second_sent_at: null,
        third_sent_at: null
      };
    }

    let stageToSend = null;

    if (!entry.first_sent_at) {
      if (config.enable_t2h) {
        stageToSend = "first";
      }
    } else if (!entry.second_sent_at && timeLeftMs <= 60 * 60 * 1000) {
      if (config.enable_t1h) {
        stageToSend = "second";
      }
    } else if (!entry.third_sent_at && timeLeftMs <= 30 * 60 * 1000) {
      if (config.enable_t30m) {
        stageToSend = "third";
      }
    }

    if (stageToSend) {
      alerts.push({
        task,
        due,
        timeLeftMs,
        stage: stageToSend
      });

      const nowIso = now.toISOString();
      if (stageToSend === "first") entry.first_sent_at = nowIso;
      if (stageToSend === "second") entry.second_sent_at = nowIso;
      if (stageToSend === "third") entry.third_sent_at = nowIso;
    }

    newState[taskId] = entry;
  }

  for (const key of Object.keys(newState)) {
    if (!activeTaskIds.has(String(key))) {
      delete newState[key];
    }
  }

  alerts.sort((a, b) => a.due.getTime() - b.due.getTime());

  const limitedAlerts = alerts.slice(0, config.max_alerts_per_run || 3);

  if (limitedAlerts.length > 0) {
    const lines = limitedAlerts.map((item, index) => {
      const labels = item.task.labels?.length ? `\n   🏷️ ${item.task.labels.join(", ")}` : "";
      return [
        `*${index + 1}.* ${item.task.content}`,
        `   🗓️ Due: ${formatHumanDate(item.due.toISOString())}`,
        `   ⏳ Time left: ${formatMinutes(item.timeLeftMs)}`,
        `   🔔 Reminder stage: ${stageLabel(item.stage)}${labels}`
      ].join("\n");
    });

    const text = [
      `👀 <@${config.slack_user_id}> ${limitedAlerts.length} task${limitedAlerts.length === 1 ? "" : "s"} look due soon and still unchanged.`,
      "",
      ...lines
    ].join("\n\n");

    await postToSlack({
      channel: process.env.SLACK_REMINDER_CHANNEL_ID,
      text
    });
  }

  await saveReminderState(newState);

  return res.status(200).json({
    ok: true,
    alerts_sent: limitedAlerts.length,
    considered: alerts.length
  });
}
