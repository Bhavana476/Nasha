// Outgoing messages. Every message is recorded in the outbox; it is delivered automatically only
// when a provider is configured in Settings, otherwise it waits there to be sent by hand.
import { createHmac } from 'node:crypto';
import { db, save, newId } from './store.mjs';

async function viaTwilio(config, message) {
  const prefix = message.channel === 'whatsapp' ? 'whatsapp:' : '';
  const from = message.channel === 'whatsapp' ? config.twilioWhatsappFrom : config.twilioSmsFrom;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioSid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: prefix + message.to, From: prefix + from, Body: message.text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Twilio responded ${response.status}`);
}

async function viaWebhook(config, message) {
  const body = JSON.stringify({ channel: message.channel, to: message.to, subject: message.subject, text: message.text, kind: message.kind, ref: message.ref });
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nasha-Signature': createHmac('sha256', config.webhookSecret || '').update(body).digest('hex') },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
}

export async function deliver(message) {
  const config = db.settings.notifications;
  const twilio = config.twilioSid && config.twilioToken && (message.channel === 'whatsapp' ? config.twilioWhatsappFrom : message.channel === 'sms' ? config.twilioSmsFrom : '');
  if (!twilio && !config.webhookUrl) return;
  try {
    await (twilio ? viaTwilio(config, message) : viaWebhook(config, message));
    message.status = 'sent';
    message.error = '';
  } catch (error) {
    message.status = 'failed';
    message.error = String(error.message).slice(0, 200);
  }
  message.updatedAt = new Date().toISOString();
  save();
}

export function queue({ channel, to, text, subject = '', kind, ref = '', batch = '' }) {
  if (!to) return null;
  const message = { id: newId(), at: new Date().toISOString(), channel, to, subject, text, kind, ref, batch, status: 'manual', error: '' };
  db.outbox.unshift(message);
  db.outbox.length = Math.min(db.outbox.length, 3000);
  save();
  deliver(message);
  return message;
}

export function notifyCustomer(person, text, kind, ref) {
  const preferred = db.settings.notifications.customerChannel;
  if (preferred === 'email' && person.email) return queue({ channel: 'email', to: person.email, subject: `${db.settings.info.name}: ${kind}`, text, kind, ref });
  return queue({ channel: preferred === 'sms' ? 'sms' : 'whatsapp', to: person.phone, text, kind, ref });
}

export function notifyStaff(text, kind, ref) {
  for (const recipient of db.settings.notifications.recipients) {
    const email = recipient.includes('@');
    queue({ channel: email ? 'email' : db.settings.notifications.customerChannel === 'sms' ? 'sms' : 'whatsapp', to: recipient, subject: `${db.settings.info.name}: ${kind}`, text, kind: `staff: ${kind}`, ref });
  }
}
