'use strict';

const nodemailer = require('nodemailer');
const { getDb } = require('../db/database');
const { config } = require('../config');
const path = require('path');
const fs = require('fs');

class NotifierService {
  constructor(options = {}) {
    this.db = options.db || getDb();
    this.config = options.config || config;
    this.mediaCapture = options.mediaCapture || null;
    this.emailTransporter = null;

    this.initEmail();
  }

  initEmail() {
    if (this.config.SMTP_HOST && this.config.NOTIFY_EMAIL_TO) {
      try {
        this.emailTransporter = nodemailer.createTransport({
          host: this.config.SMTP_HOST,
          port: this.config.SMTP_PORT,
          secure: this.config.SMTP_PORT === 465,
          auth: this.config.SMTP_USER ? {
            user: this.config.SMTP_USER,
            pass: this.config.SMTP_PASS
          } : undefined,
          connectionTimeout: 5000,
          socketTimeout: 5000
        });
      } catch (err) {
        console.error('[Notifier] Failed to initialize email transporter:', err.message);
      }
    }
  }

  recordNotification({ eventId, channel, outcome, detail = null, attemptedAt, providerAcceptedAt = null }) {
    try {
      this.db.prepare(`
        INSERT INTO notifications (event_id, channel, outcome, detail, attempted_at, provider_accepted_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        channel,
        outcome,
        detail,
        attemptedAt,
        providerAcceptedAt
      );
    } catch (err) {
      console.error('[Notifier] Failed to record notification row:', err.message);
    }
  }

  async notifyEvent(event, { frameJpeg = null, baseUrl = 'http://localhost:3000' } = {}) {
    const promises = [];
    const eventId = event.eventId || event.event_id;

    // Email notification
    if (this.emailTransporter && this.config.NOTIFY_EMAIL_TO) {
      promises.push(this.sendEmail(event, frameJpeg, baseUrl));
    }

    // Telegram notification
    if (this.config.TELEGRAM_BOT_TOKEN && this.config.TELEGRAM_CHAT_ID) {
      promises.push(this.sendTelegram(event, frameJpeg, baseUrl));
    }

    if (promises.length === 0) {
      // Record suppressed outcome when no channel configured
      const attemptedAt = new Date().toISOString();
      this.recordNotification({
        eventId,
        channel: 'Email',
        outcome: 'Suppressed',
        detail: 'No email or telegram channels configured',
        attemptedAt
      });
    }

    return Promise.allSettled(promises);
  }

  async sendEmail(event, frameJpeg, baseUrl) {
    const attemptedAt = new Date().toISOString();
    const eventId = event.eventId || event.event_id;
    const startTime = event.startTime || event.start_time;
    const detectionType = event.detectionType || event.detection_type;
    const peakArea = event.peakChangedArea !== undefined ? event.peakChangedArea : (event.changedArea !== undefined ? event.changedArea : event.changed_area);
    const eventUrl = `${baseUrl}/events/${eventId}`;

    const textBody = `ISSS Surveillance Alert\n\n` +
      `Motion detected at: ${startTime}\n` +
      `Detection Type: ${detectionType}\n` +
      `Peak Changed Area: ${peakArea}%\n` +
      `Event Details: ${eventUrl}\n\n` +
      `This is an automated alert from your ISSS edge surveillance node.`;

    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 500px; padding: 20px; border: 1px solid #ddd;">
        <h2 style="color: #0b57d0; margin-top: 0;">ISSS Motion Alert</h2>
        <p><strong>Event ID:</strong> ${eventId}</p>
        <p><strong>Timestamp:</strong> ${startTime}</p>
        <p><strong>Detection Mode:</strong> ${detectionType}</p>
        <p><strong>Peak Changed Area:</strong> ${peakArea}%</p>
        <p style="margin-top: 20px;">
          <a href="${eventUrl}" style="background-color: #0b57d0; color: #fff; padding: 10px 16px; text-decoration: none; border-radius: 4px;">
            View Event Details
          </a>
        </p>
      </div>
    `;

    const mailOptions = {
      from: this.config.NOTIFY_EMAIL_FROM || 'isss-alert@edge-node.local',
      to: this.config.NOTIFY_EMAIL_TO,
      subject: `[ISSS Alert] Motion Detected (${eventId})`,
      text: textBody,
      html: htmlBody
    };

    // Opt-in image attachment per Section 5.8
    if (this.config.NOTIFY_ATTACH_IMAGE && frameJpeg) {
      mailOptions.attachments = [{
        filename: `${eventId}.jpg`,
        content: frameJpeg
      }];
    }

    try {
      // 5-second bounded timeout
      const sendPromise = this.emailTransporter.sendMail(mailOptions);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Email provider connection timeout (5s)')), 5000)
      );

      const info = await Promise.race([sendPromise, timeoutPromise]);
      const acceptedAt = new Date().toISOString();

      this.recordNotification({
        eventId,
        channel: 'Email',
        outcome: 'AcceptedByProvider',
        detail: `Message accepted by SMTP server. Response: ${info.response || 'OK'}`,
        attemptedAt,
        providerAcceptedAt: acceptedAt
      });
      return true;
    } catch (err) {
      this.recordNotification({
        eventId,
        channel: 'Email',
        outcome: 'Failed',
        detail: err.message,
        attemptedAt
      });
      return false;
    }
  }

  async sendTelegram(event, frameJpeg, baseUrl) {
    const attemptedAt = new Date().toISOString();
    const eventId = event.eventId || event.event_id;
    const startTime = event.startTime || event.start_time;
    const detectionType = event.detectionType || event.detection_type;
    const peakArea = event.peakChangedArea !== undefined ? event.peakChangedArea : (event.changedArea !== undefined ? event.changedArea : event.changed_area);
    const eventUrl = `${baseUrl}/events/${eventId}`;
    const token = this.config.TELEGRAM_BOT_TOKEN;
    const chatId = this.config.TELEGRAM_CHAT_ID;

    const message = `🚨 *ISSS Motion Alert*\n` +
      `*Event:* \`${eventId}\`\n` +
      `*Time:* ${startTime}\n` +
      `*Type:* ${detectionType}\n` +
      `*Area:* ${peakArea}%\n` +
      `[View Event Details](${eventUrl})`;

    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const data = await res.json();
      if (res.ok && data.ok) {
        const acceptedAt = new Date().toISOString();
        this.recordNotification({
          eventId,
          channel: 'Telegram',
          outcome: 'AcceptedByProvider',
          detail: `Message ID: ${data.result ? data.result.message_id : 'OK'}`,
          attemptedAt,
          providerAcceptedAt: acceptedAt
        });
        return true;
      } else {
        throw new Error(data.description || `HTTP ${res.status}`);
      }
    } catch (err) {
      this.recordNotification({
        eventId,
        channel: 'Telegram',
        outcome: 'Failed',
        detail: err.message,
        attemptedAt
      });
      return false;
    }
  }
}

module.exports = NotifierService;
