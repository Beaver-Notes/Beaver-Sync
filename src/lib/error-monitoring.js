"use strict";

const Sentry = require("@sentry/node");

function initErrorMonitoring(dsn, opts = {}) {
  if (!dsn || typeof dsn !== "string") {
    console.warn("[error-monitoring] No DSN provided - skipping init");
    return null;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
      }
      if (event.request?.headers) {
        const headers = event.request.headers;
        delete headers["authorization"];
        delete headers["cookie"];
        delete headers["bsession"];
        delete headers["x-device-id"];
        delete headers["x-device-label"];
        delete headers["x-workspace-id"];
        delete headers["x-compacted-commits"];
        delete headers["x-note-id"];
      }
      if (event.extra) {
        delete event.extra.password;
        delete event.extra.token;
        delete event.extra.sessionToken;
        delete event.extra.bsession;
      }
      return event;
    },
    ...opts,
  });

  console.log("[error-monitoring] Initialized");
  return Sentry;
}

module.exports = { initErrorMonitoring };
