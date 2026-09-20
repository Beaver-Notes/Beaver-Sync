'use strict';

// Email verification is advisory: no delivery pipeline ever sets
// `email_verified` (the column defaults to FALSE and is never back-filled), so
// a hard 403 would permanently block sharing. These fields keep the state
// visible in success responses so the client can keep showing its hint.
function emailVerificationFields(emailVerified) {
  return emailVerified
    ? { emailVerified: true }
    : { emailVerified: false, warning: 'EMAIL_NOT_VERIFIED' };
}

module.exports = { emailVerificationFields };
