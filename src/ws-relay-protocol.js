'use strict';

// The relay no longer terminates the Yjs wire protocol: client frames are
// end-to-end encrypted and forwarded verbatim (see ws-relay.js), so there are
// no protocol handlers left here.
module.exports = {};