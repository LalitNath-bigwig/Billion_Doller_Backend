import { workflow, node, trigger, expr } from "@n8n/workflow-sdk";

const timer = trigger({
  type: "n8n-nodes-base.scheduleTrigger", version: 1.2,
  config: { name: "Check for verified signups every minute", parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 1 }] } } },
});

const manual = trigger({
  type: "n8n-nodes-base.manualTrigger", version: 1, config: { name: "Preview without sending" },
});

const chat = node({
  type: "n8n-nodes-base.telegram", version: 1.2,
  config: { name: "Read BDFX Agent group", parameters: { resource: "chat", operation: "get", chatId: "-1004383714191" },
    credentials: { telegramApi: { id: "axPPbOzMxfl83fly", name: "BDFX Reports - Telegram bot" } } },
});

const verifyChat = node({
  type: "n8n-nodes-base.code", version: 2,
  config: { name: "Verify Agent group before claiming", parameters: { jsCode: "const chat = $input.first().json.result ?? $input.first().json;\nif (String(chat.id) !== \"-1004383714191\" || ![\"group\", \"supergroup\"].includes(chat.type)) throw new Error(\"BDFX Agent group unavailable\");\nif (chat.permissions?.can_send_messages === false) throw new Error(\"BDFX Agent group does not allow posting\");\nreturn [{ json: {} }];" } },
});

const claim = node({
  type: "n8n-nodes-base.httpRequest", version: 4.3,
  config: { name: "Claim one verified BDFX registration", parameters: { method: "POST",
    url: "https://billion-doller-backend.onrender.com/api/support-chat/n8n/agent-registrations/claim", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", options: { timeout: 10000 } },
    credentials: { httpHeaderAuth: { id: "P40uhFcGFRFBkBZd", name: "BDFX Daily Reports - read-only source" } } },
});

const message = node({
  type: "n8n-nodes-base.code", version: 2,
  config: { name: "Format verified BDFX registration", parameters: { jsCode: "const render = item => {\n  if (!/^[a-f0-9]{24}$/.test(item.registrationId) || !Number.isFinite(Date.parse(item.registeredAt))) throw new Error(\"Invalid registration notice\");\n  const time = new Intl.DateTimeFormat(\"en-GB\", { timeZone: \"Asia/Dubai\", dateStyle: \"medium\", timeStyle: \"short\" }).format(new Date(item.registeredAt));\n  return [\"BDFX | New registration\", \"Registration ID: \" + item.registrationId, \"Verified: \" + time + \" Dubai\"].join(\"\\n\");\n};\nconst items = $input.first().json.items;\nif (!Array.isArray(items) || items.length > 1 || items.some(item => typeof item.claimToken !== \"string\")) throw new Error(\"Invalid BDFX registration source\");\nreturn items.map(item => ({ json: { registrationId: item.registrationId, claimToken: item.claimToken, text: render(item) } }));" } },
});

const preview = node({
  type: "n8n-nodes-base.code", version: 2,
  config: { name: "Display a sample message", parameters: { jsCode: "const render = item => {\n  if (!/^[a-f0-9]{24}$/.test(item.registrationId) || !Number.isFinite(Date.parse(item.registeredAt))) throw new Error(\"Invalid registration notice\");\n  const time = new Intl.DateTimeFormat(\"en-GB\", { timeZone: \"Asia/Dubai\", dateStyle: \"medium\", timeStyle: \"short\" }).format(new Date(item.registeredAt));\n  return [\"BDFX | New registration\", \"Registration ID: \" + item.registrationId, \"Verified: \" + time + \" Dubai\"].join(\"\\n\");\n};\nreturn [{ json: { preview: render({ registrationId: \"000000000000000000000001\", registeredAt: \"2026-11-16T12:00:00.000Z\" }) } }];" } },
});

const send = node({
  type: "n8n-nodes-base.telegram", version: 1.2,
  config: { name: "Post to BDFX Agent group", parameters: {
    resource: "message", operation: "sendMessage", chatId: "-1004383714191", text: expr("{{ $json.text }}"), additionalFields: { appendAttribution: false } },
    credentials: { telegramApi: { id: "axPPbOzMxfl83fly", name: "BDFX Reports - Telegram bot" } }, retryOnFail: false },
});

const receipt = node({
  type: "n8n-nodes-base.code", version: 2,
  config: { name: "Validate Telegram delivery receipt", parameters: { jsCode: "const delivered = $input.first().json.result ?? $input.first().json;\nif (String(delivered.chat?.id) !== \"-1004383714191\" || !Number.isSafeInteger(delivered.message_id) || delivered.message_id < 1) throw new Error(\"Telegram delivery could not be confirmed\");\nconst notice = $(\"Format verified BDFX registration\").first().json;\nreturn [{ json: { registrationId: notice.registrationId, claimToken: notice.claimToken, chatId: \"-1004383714191\", messageId: delivered.message_id } }];" } },
});

const saveReceipt = node({
  type: "n8n-nodes-base.httpRequest", version: 4.3,
  config: { name: "Record BDFX registration delivery", parameters: { method: "POST",
    url: "https://billion-doller-backend.onrender.com/api/support-chat/n8n/agent-registrations/receipt", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
    sendBody: true, specifyBody: "json", jsonBody: expr("{{ $json }}"), options: { timeout: 10000 } },
    credentials: { httpHeaderAuth: { id: "P40uhFcGFRFBkBZd", name: "BDFX Daily Reports - read-only source" } } },
});

export default workflow("bdfx-agent-registration-notices", "BDFX | Agent group new registrations")
  .add(manual).to(preview)
  .add(timer).to(chat).to(verifyChat).to(claim).to(message).to(send).to(receipt).to(saveReceipt);
