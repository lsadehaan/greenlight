import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client.js";
import { recordAuditEvent } from "../services/audit.js";

export const NOTIFICATION_QUEUE_NAME = "notification";

export interface NotificationJobData {
  submissionId: string;
  contentPreview: string;
  channel: string;
  contentType: string;
  policyFlags: Array<{ policy_name: string; action: string; detail: string }>;
  guardrailFlags: Array<{ guardrail_name: string; verdict: string; reasoning: string | null }>;
  approveToken: string;
  rejectToken: string;
  tokenExpiresAt: string;
}

interface SlackChannelConfig {
  webhook_url: string;
}

interface EmailChannelConfig {
  recipients: string[];
}

export function createNotificationQueue(redisUrl: string): Queue<NotificationJobData> {
  const url = new URL(redisUrl);
  return new Queue(NOTIFICATION_QUEUE_NAME, {
    connection: {
      host: url.hostname,
      port: parseInt(url.port || "6379", 10),
    },
  });
}

export async function enqueueNotification(
  queue: Queue<NotificationJobData>,
  data: NotificationJobData,
): Promise<void> {
  await queue.add("notify", data, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  });
}

export function createNotificationWorker(
  prisma: PrismaClient,
  redisUrl: string,
  smtpConfig: { host: string; port: number; user: string; pass: string; from: string },
  appBaseUrl: string,
): Worker<NotificationJobData> {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };

  const worker = new Worker<NotificationJobData>(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await processNotificationJob(prisma, job.data, smtpConfig, appBaseUrl);
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    if (job) {
      console.error(
        `Notification job failed for submission ${job.data.submissionId} (attempt ${job.attemptsMade}): ${err.message}`,
      );
    }
  });

  return worker;
}

/** Core processing logic - exported for testing */
export async function processNotificationJob(
  prisma: PrismaClient,
  data: NotificationJobData,
  smtpConfig: { host: string; port: number; user: string; pass: string; from: string },
  appBaseUrl: string,
): Promise<void> {
  const channels = await prisma.notificationChannel.findMany({
    where: { active: true },
  });

  if (channels.length === 0) {
    return;
  }

  const approveUrl = `${appBaseUrl}/api/v1/review-actions/${data.approveToken}`;
  const rejectUrl = `${appBaseUrl}/api/v1/review-actions/${data.rejectToken}`;

  for (const ch of channels) {
    try {
      if (ch.type === "slack") {
        await sendSlackNotification(
          ch.config as unknown as SlackChannelConfig,
          data,
          approveUrl,
          rejectUrl,
        );
      } else if (ch.type === "email") {
        await sendEmailNotification(
          ch.config as unknown as EmailChannelConfig,
          data,
          smtpConfig,
          approveUrl,
          rejectUrl,
        );
      }

      try {
        await recordAuditEvent(prisma, {
          eventType: "submission.created",
          submissionId: data.submissionId,
          actor: `notification:${ch.type}`,
          actorType: "system",
          payload: {
            notification_channel_id: ch.id,
            notification_type: ch.type,
            status: "delivered",
          },
        });
      } catch {
        // Best-effort
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Notification delivery failed for channel ${ch.id} (${ch.type}): ${errorMsg}`);

      try {
        await recordAuditEvent(prisma, {
          eventType: "submission.created",
          submissionId: data.submissionId,
          actor: `notification:${ch.type}`,
          actorType: "system",
          payload: {
            notification_channel_id: ch.id,
            notification_type: ch.type,
            status: "failed",
            error: errorMsg,
          },
        });
      } catch {
        // Best-effort
      }
    }
  }
}

export function buildSlackPayload(
  data: NotificationJobData,
  approveUrl: string,
  rejectUrl: string,
): object {
  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "New Submission Needs Review",
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Submission:*\n${data.submissionId}` },
        { type: "mrkdwn", text: `*Channel:*\n${data.channel}` },
        { type: "mrkdwn", text: `*Content Type:*\n${data.contentType}` },
        {
          type: "mrkdwn",
          text: `*Expires:*\n${new Date(data.tokenExpiresAt).toUTCString()}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Content Preview:*\n\`\`\`${truncate(data.contentPreview, 500)}\`\`\``,
      },
    },
  ];

  if (data.policyFlags.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Policy Flags:*\n" +
          data.policyFlags
            .map((f) => `- :warning: *${f.policy_name}* (${f.action}): ${f.detail}`)
            .join("\n"),
      },
    });
  }

  if (data.guardrailFlags.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Guardrail Flags:*\n" +
          data.guardrailFlags
            .map(
              (g) =>
                `- :shield: *${g.guardrail_name}* (${g.verdict})${g.reasoning ? `: ${g.reasoning}` : ""}`,
            )
            .join("\n"),
      },
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          url: approveUrl,
          action_id: "approve_submission",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          url: rejectUrl,
          action_id: "reject_submission",
        },
      ],
    },
  );

  return { blocks };
}

export function buildEmailHtml(
  data: NotificationJobData,
  approveUrl: string,
  rejectUrl: string,
): string {
  const policySection =
    data.policyFlags.length > 0
      ? `<h3>Policy Flags</h3><ul>${data.policyFlags.map((f) => `<li><strong>${escapeHtml(f.policy_name)}</strong> (${escapeHtml(f.action)}): ${escapeHtml(f.detail)}</li>`).join("")}</ul>`
      : "";

  const guardrailSection =
    data.guardrailFlags.length > 0
      ? `<h3>Guardrail Flags</h3><ul>${data.guardrailFlags.map((g) => `<li><strong>${escapeHtml(g.guardrail_name)}</strong> (${escapeHtml(g.verdict)})${g.reasoning ? `: ${escapeHtml(g.reasoning)}` : ""}</li>`).join("")}</ul>`
      : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h2>New Submission Needs Review</h2>
  <table style="border-collapse: collapse; width: 100%; margin-bottom: 16px;">
    <tr><td style="padding: 4px 8px; font-weight: bold;">Submission ID</td><td style="padding: 4px 8px;">${escapeHtml(data.submissionId)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Channel</td><td style="padding: 4px 8px;">${escapeHtml(data.channel)}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Content Type</td><td style="padding: 4px 8px;">${escapeHtml(data.contentType)}</td></tr>
  </table>
  <h3>Content Preview</h3>
  <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto;">${escapeHtml(truncate(data.contentPreview, 1000))}</pre>
  ${policySection}
  ${guardrailSection}
  <div style="margin-top: 24px;">
    <a href="${approveUrl}" style="display: inline-block; padding: 10px 24px; background: #22c55e; color: white; text-decoration: none; border-radius: 4px; margin-right: 8px;">Approve</a>
    <a href="${rejectUrl}" style="display: inline-block; padding: 10px 24px; background: #ef4444; color: white; text-decoration: none; border-radius: 4px;">Reject</a>
  </div>
  <p style="color: #888; font-size: 12px; margin-top: 16px;">Action links expire at ${escapeHtml(new Date(data.tokenExpiresAt).toUTCString())}. Each link can only be used once.</p>
</body>
</html>`;
}

async function sendSlackNotification(
  config: SlackChannelConfig,
  data: NotificationJobData,
  approveUrl: string,
  rejectUrl: string,
): Promise<void> {
  const payload = buildSlackPayload(data, approveUrl, rejectUrl);
  const resp = await fetch(config.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook returned status ${resp.status}`);
  }
}

async function sendEmailNotification(
  channelConfig: EmailChannelConfig,
  data: NotificationJobData,
  smtpConfig: { host: string; port: number; user: string; pass: string; from: string },
  approveUrl: string,
  rejectUrl: string,
): Promise<void> {
  if (!smtpConfig.host) {
    throw new Error("SMTP not configured");
  }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465,
    auth: smtpConfig.user ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined,
  });

  const html = buildEmailHtml(data, approveUrl, rejectUrl);

  await transporter.sendMail({
    from: smtpConfig.from,
    to: channelConfig.recipients.join(", "),
    subject: `[Greenlight] Review needed: ${data.submissionId}`,
    html,
  });
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
