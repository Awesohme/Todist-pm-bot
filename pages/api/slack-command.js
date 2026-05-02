import { waitUntil } from "@vercel/functions";
import {
  readRawBody,
  verifySlackSignature,
  parseSlackForm,
  getReminderConfig,
  saveReminderConfig,
  fetchTodoistTasks,
  bucketTasks,
  quickTodayReply,
  quickFollowupsReply,
  quickPrioritiesReply,
  parseSnoozeInput
} from "../../lib/agent-helpers.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

async function respondToSlack(responseUrl, text, responseType = "ephemeral") {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      response_type: responseType,
      text,
    }),
  });

  if (!res.ok) {
    throw new Error(`response_url post failed: ${res.status}`);
  }
}

function immediateAck(res, text = "🧠 Got it — working on that now...") {
  return res.status(200).json({
    response_type: "ephemeral",
    text,
  });
}

async function handleCommandAsync(form) {
  const text = String(form.text || "").trim();
  const command = text.toLowerCase();
  const userId = form.user_id;
  const responseUrl = form.response_url;

  let config = await getReminderConfig();
  config.slack_user_id = userId || config.slack_user_id;

  if (!text || command === "help") {
    await saveReminderConfig(config);
    return respondToSlack(
      responseUrl,
      [
        "*Available `/agent` commands*",
        "• `/agent today`",
        "• `/agent followups`",
        "• `/agent priorities`",
        "• `/agent settings`",
        "• `/agent pause-reminders`",
        "• `/agent resume-reminders`",
        "• `/agent snooze 4h`",
        "• `/agent disable 30m`",
        "• `/agent enable all`",
        "• `/agent enable overnight`",
        "• `/agent disable overnight`",
        "• `/agent pause-agent`",
        "• `/agent resume-agent`"
      ].join("\n")
    );
  }

  if (command === "settings") {
    await saveReminderConfig(config);
    return respondToSlack(
      responseUrl,
      [
        "*Reminder settings*",
        `• agent paused: ${config.agentPaused ? "yes" : "no"}`,
        `• reminders enabled: ${config.reminders_enabled ? "yes" : "no"}`,
        `• snoozed until: ${config.snoozed_until || "not snoozed"}`,
        `• T-2h: ${config.enable_t2h ? "on" : "off"}`,
        `• T-1h: ${config.enable_t1h ? "on" : "off"}`,
        `• T-30m: ${config.enable_t30m ? "on" : "off"}`,
        `• max alerts per run: ${config.max_alerts_per_run}`,
        `• mode: ${config.mode}`,
        `• quiet hours enabled: ${config.quietHours.enabled ? "yes" : "no"}`,
        `• quiet window: ${config.quietHours.start} → ${config.quietHours.end}`,
        `• quiet timezone: ${config.quietHours.timezone}`,
        `• overnight reminders allowed: ${config.quietHours.allowDuringQuietHours ? "yes" : "no"}`,
        `• reminder target user: ${config.slack_user_id ? `<@${config.slack_user_id}>` : "not set yet"}`
      ].join("\n")
    );
  }

  if (command === "pause-agent") {
    config.agentPaused = true;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "⏸️ Agent paused. Hourly reminder runs will now skip.");
  }

  if (command === "resume-agent") {
    config.agentPaused = false;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "✅ Agent resumed.");
  }

  if (command === "pause-reminders") {
    config.reminders_enabled = false;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "⏸️ Reminders paused.");
  }

  if (command === "resume-reminders") {
    config.reminders_enabled = true;
    config.snoozed_until = null;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "✅ Reminders resumed.");
  }

  if (command.startsWith("snooze")) {
    const snoozedUntil = parseSnoozeInput(command);
    if (!snoozedUntil) {
      return respondToSlack(
        responseUrl,
        "⚠️ Use something like `/agent snooze 4h` or `/agent snooze 30m`."
      );
    }

    config.snoozed_until = snoozedUntil;
    config.reminders_enabled = true;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, `😴 Reminders snoozed until ${snoozedUntil}.`);
  }

  if (command === "disable 30m") {
    config.enable_t30m = false;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "🔕 30-minute reminders disabled.");
  }

  if (command === "enable all") {
    config.reminders_enabled = true;
    config.snoozed_until = null;
    config.enable_t2h = true;
    config.enable_t1h = true;
    config.enable_t30m = true;
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "✅ All reminder stages enabled.");
  }

  if (command === "enable overnight") {
    config.allow_overnight_reminders = true;
    config.quietHours = {
      ...config.quietHours,
      allowDuringQuietHours: true
    };
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "🌙 Overnight reminders enabled.");
  }

  if (command === "disable overnight") {
    config.allow_overnight_reminders = false;
    config.quietHours = {
      ...config.quietHours,
      allowDuringQuietHours: false
    };
    await saveReminderConfig(config);
    return respondToSlack(responseUrl, "🌙 Quiet hours restored. Overnight reminders disabled.");
  }

  if (command === "today" || command === "followups" || command === "priorities") {
    const tasks = await fetchTodoistTasks();
    const buckets = bucketTasks(tasks);
    await saveReminderConfig(config);

    if (command === "today") {
      return respondToSlack(responseUrl, quickTodayReply(buckets));
    }
    if (command === "followups") {
      return respondToSlack(responseUrl, quickFollowupsReply(buckets));
    }
    return respondToSlack(responseUrl, quickPrioritiesReply(buckets));
  }

  return respondToSlack(
    responseUrl,
    "🤔 I don’t know that `/agent` command yet. Try `/agent help`."
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Slack command endpoint is live");
  }

  const rawBody = await readRawBody(req);

  if (!verifySlackSignature(req, rawBody, process.env.SLACK_SIGNING_SECRET)) {
    return res.status(401).send("Invalid signature");
  }

  const form = parseSlackForm(rawBody);

  immediateAck(res);

  waitUntil(
    handleCommandAsync(form).catch(async (err) => {
      console.error("slash command failed:", err);

      try {
        await respondToSlack(
          form.response_url,
          `⚠️ /agent failed.\nReason: ${err.message}`
        );
      } catch (postErr) {
        console.error("failed posting slash error:", postErr);
      }
    })
  );
}
