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

function jsonResponse(res, text) {
  return res.status(200).json({
    response_type: "ephemeral",
    text,
  });
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
  const text = String(form.text || "").trim();
  const command = text.toLowerCase();
  const userId = form.user_id;

  let config = await getReminderConfig();
  config.slack_user_id = userId || config.slack_user_id;

  if (!text || command === "help") {
    await saveReminderConfig(config);
    return jsonResponse(
      res,
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
        "• `/agent enable all`"
      ].join("\n")
    );
  }

  if (command === "settings") {
    await saveReminderConfig(config);
    return jsonResponse(
      res,
      [
        "*Reminder settings*",
        `• enabled: ${config.reminders_enabled ? "yes" : "no"}`,
        `• snoozed until: ${config.snoozed_until || "not snoozed"}`,
        `• T-2h: ${config.enable_t2h ? "on" : "off"}`,
        `• T-1h: ${config.enable_t1h ? "on" : "off"}`,
        `• T-30m: ${config.enable_t30m ? "on" : "off"}`,
        `• max alerts per run: ${config.max_alerts_per_run}`,
        `• mode: ${config.mode}`,
        `• reminder target user: ${config.slack_user_id ? `<@${config.slack_user_id}>` : "not set yet"}`
      ].join("\n")
    );
  }

  if (command === "pause-reminders") {
    config.reminders_enabled = false;
    await saveReminderConfig(config);
    return jsonResponse(res, "⏸️ Reminders paused.");
  }

  if (command === "resume-reminders") {
    config.reminders_enabled = true;
    config.snoozed_until = null;
    await saveReminderConfig(config);
    return jsonResponse(res, "✅ Reminders resumed.");
  }

  if (command.startsWith("snooze")) {
    const snoozedUntil = parseSnoozeInput(command);
    if (!snoozedUntil) {
      return jsonResponse(res, "⚠️ Use something like `/agent snooze 4h` or `/agent snooze 30m`.");
    }

    config.snoozed_until = snoozedUntil;
    config.reminders_enabled = true;
    await saveReminderConfig(config);
    return jsonResponse(res, `😴 Reminders snoozed until ${snoozedUntil}.`);
  }

  if (command === "disable 30m") {
    config.enable_t30m = false;
    await saveReminderConfig(config);
    return jsonResponse(res, "🔕 30-minute reminders disabled.");
  }

  if (command === "enable all") {
    config.reminders_enabled = true;
    config.snoozed_until = null;
    config.enable_t2h = true;
    config.enable_t1h = true;
    config.enable_t30m = true;
    await saveReminderConfig(config);
    return jsonResponse(res, "✅ All reminder stages enabled.");
  }

  if (command === "today" || command === "followups" || command === "priorities") {
    const tasks = await fetchTodoistTasks();
    const buckets = bucketTasks(tasks);
    await saveReminderConfig(config);

    if (command === "today") {
      return jsonResponse(res, quickTodayReply(buckets));
    }
    if (command === "followups") {
      return jsonResponse(res, quickFollowupsReply(buckets));
    }
    return jsonResponse(res, quickPrioritiesReply(buckets));
  }

  return jsonResponse(
    res,
    "🤔 I don’t know that `/agent` command yet. Try `/agent help`."
  );
}
