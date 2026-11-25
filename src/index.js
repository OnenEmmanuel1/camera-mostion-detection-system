'use strict';

const express = require('express');
const { Readable } = require('node:stream');

const app = express();
const MAX_PROXY_REQUEST_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding'
]);

function getBackendOrigin() {
  const configured = process.env.BACKEND_ORIGIN;
  if (!configured) return null;

  try {
    const origin = new URL(configured);
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(origin.hostname);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash ||
        (origin.protocol !== 'https:' && (process.env.NODE_ENV === 'production' || !isLocal))) {
      return null;
    }
    return origin;
  } catch (_) {
    return null;
  }
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_PROXY_REQUEST_BYTES) {
      const error = new Error('Request body exceeds the proxy limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks, size) : undefined;
}

app.use(async (req, res) => {
  const backendOrigin = getBackendOrigin();
  if (!backendOrigin) {
    return res.status(503).type('text/plain').send('Vercel backend is not configured. Set BACKEND_ORIGIN to the HTTPS origin of the always-on ISSS server.');
  }

  const clientHost = String(req.headers.host || '');
  const originalUrl = req.originalUrl || '/';
  let backendUrl;
  try {
    // Keep all paths on the configured backend origin; never allow a request path
    // beginning with // to turn the proxy into an open redirect or SSRF endpoint.
    if (!originalUrl.startsWith('/') || originalUrl.startsWith('//')) throw new Error('Invalid request path');
    backendUrl = new URL(originalUrl, backendOrigin);
    if (backendUrl.origin !== backendOrigin.origin) throw new Error('Invalid request origin');
  } catch (_) {
    return res.status(400).type('text/plain').send('Invalid request path.');
  }

  const abortController = new AbortController();
  const abortForClient = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.on('aborted', abortForClient);
  res.on('close', abortForClient);

  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRequestBody(req);
    const headers = new Headers();
    for (const [name, rawValue] of Object.entries(req.headers)) {
      const lowerName = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName.startsWith('x-forwarded-')) continue;
      if (Array.isArray(rawValue)) rawValue.forEach(value => headers.append(name, value));
      else if (rawValue !== undefined) headers.set(name, rawValue);
    }

    headers.set('x-forwarded-host', clientHost);
    headers.set('x-forwarded-proto', 'https');
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

    const upstream = await fetch(backendUrl, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(295_000)])
    });

    res.status(upstream.status);
    for (const [name, value] of upstream.headers) {
      const lowerName = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'set-cookie' || lowerName === 'content-encoding') continue;
      if (lowerName === 'location') {
        try {
          const location = new URL(value, backendOrigin);
          if (location.origin === backendOrigin.origin) {
            location.protocol = 'https:';
            location.host = clientHost;
            res.setHeader(name, location.toString());
            continue;
          }
        } catch (_) {}
      }
      res.setHeader(name, value);
    }

    const cookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
    if (cookies.length) res.setHeader('set-cookie', cookies);

    if (req.method === 'HEAD' || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body)
      .on('error', error => {
        if (!res.headersSent) res.status(502).end('Backend stream failed.');
        else res.destroy(error);
      })
      .pipe(res);
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      const status = error.statusCode || (error.name === 'TimeoutError' ? 504 : 502);
      res.status(status).type('text/plain').send(status === 504 ? 'Backend request timed out.' : 'Could not reach the ISSS backend.');
    } else {
      res.destroy(error);
    }
  }
});

module.exports = app;
