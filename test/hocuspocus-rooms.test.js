'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseRoomName } = require('../src/hocuspocus');

describe('parseRoomName', () => {
  test('parses note rooms with underscore IDs', () => {
    const r = parseRoomName('workspace:ws_01:note:not_e-ID_9');
    assert.deepStrictEqual(r, { kind: 'note', workspaceId: 'ws_01', noteId: 'not_e-ID_9' });
  });

  test('parses the meta room', () => {
    const r = parseRoomName('workspace:ws_01:meta');
    assert.deepStrictEqual(r, { kind: 'meta', workspaceId: 'ws_01', noteId: null });
  });

  test('rejects malformed rooms', () => {
    for (const name of [
      'workspace:ws:notes:x',
      'workspace:ws:',
      'workspace::meta',
      'workspace:ws:meta:extra',
      'garbage',
      'workspace:w.s:note:n',
    ]) {
      assert.strictEqual(parseRoomName(name), null, `expected null for ${name}`);
    }
  });
});
