'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('Postgres HA integration', () => {
  let pgAvailable = true;

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    try {
      const { query } = require('../../src/db/postgres');
      await query('SELECT 1');
    } catch {
      pgAvailable = false;
    }
  });

  after(async () => {
    const { close } = require('../../src/db/postgres');
    await close();
  });

  it('can connect to Postgres', { skip: () => !pgAvailable }, async () => {
    const { query } = require('../../src/db/postgres');
    const result = await query('SELECT NOW()');
    assert(result.rows[0].now);
  });

  it('can run migrations', { skip: () => !pgAvailable }, async () => {
    const { runMigrations } = require('../../src/db/migrate-postgres');
    await runMigrations();
  });

  it('can create and query account', { skip: () => !pgAvailable }, async () => {
    const { Account } = require('../../src/models');
    const account = await Account.create({
      emailHmac: 'test@example.com',
      username: 'testuser',
    });
    assert(account.id);

    const found = await Account.findById(account.id).lean();
    assert(found.emailHmac === 'test@example.com');

    await Account.deleteOne({ _id: account.id });
  });

  it('can use transactions', { skip: () => !pgAvailable }, async () => {
    const { transaction } = require('../../src/db/postgres');
    const result = await transaction(async (client) => {
      const res = await client.query('SELECT 1 as num');
      return res.rows[0].num;
    });
    assert(result === 1);
  });
});
