// Cloudflare Email Worker: receives mail for @notify.beavernotes.com and
// forwards it to the API's /email/inbound webhook, signed with
// X-Webhook-Signature = HMAC-SHA256 hex of the exact JSON body sent.
// This is the contract src/routes/email.js enforces (INBOUND_WEBHOOK_SECRET).
import PostalMime from 'postal-mime';

const enc = new TextEncoder();

export default {
  async email(message, env) {
    const payload = {
      to: message.to,
      from: message.from,
      subject: message.headers.get('subject') ?? '',
      html: '',
      text: '',
    };

    try {
      const parsed = await PostalMime.parse(message.raw);
      payload.subject = parsed.subject ?? payload.subject;
      payload.from = parsed.from?.address ?? payload.from;
      payload.html = parsed.html ?? '';
      payload.text = parsed.text ?? '';
      if (parsed.deliveredTo) payload.to = parsed.deliveredTo;
    } catch (err) {
      console.error('notify-inbound: MIME parse failed', err);
    }

    const raw = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(env.NOTIFY_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
    const signature = [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const res = await fetch(`${env.NOTIFY_API_URL}/email/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      },
      body: raw,
    });
    if (!res.ok) {
      console.error('notify-inbound: API rejected delivery', res.status, await res.text());
    }
  },
};
