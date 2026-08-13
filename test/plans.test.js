'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPlan, getQuotaBytes, getHistoryDays, getDeviceLimit,
  getFlags, isPaidPlan, isFreePlan, VALID_PLANS, resolvePlanForAccount,
} = require('../src/lib/plans');

const GB = 1024 ** 3;

test('VALID_PLANS has exactly the five tiers', () => {
  assert.deepEqual(
    [...VALID_PLANS].sort(),
    ['enterprise', 'free', 'pro', 'starter', 'team'].sort()
  );
  assert.ok(!VALID_PLANS.has('basic'));
});

test('getQuotaBytes per tier', () => {
  assert.equal(getQuotaBytes('free'), 0);
  assert.equal(getQuotaBytes('starter'), 10 * GB);
  assert.equal(getQuotaBytes('pro'), 50 * GB);
  assert.equal(getQuotaBytes('team', 5), 100 * GB + 25 * GB * 5);
  assert.equal(getQuotaBytes('team', 1), 100 * GB + 25 * GB);
  assert.equal(getQuotaBytes('enterprise'), Number.MAX_SAFE_INTEGER);
  assert.equal(getQuotaBytes('unknown'), 0);
});

test('getHistoryDays per tier', () => {
  assert.equal(getHistoryDays('free'), 0);
  assert.equal(getHistoryDays('starter'), 30);
  assert.equal(getHistoryDays('pro'), 365);
  assert.equal(getHistoryDays('team'), 365);
  assert.equal(getHistoryDays('enterprise'), null);
});

test('getDeviceLimit per tier', () => {
  assert.equal(getDeviceLimit('starter'), 5);
  assert.equal(getDeviceLimit('free'), null);
  assert.equal(getDeviceLimit('pro'), null);
  assert.equal(getDeviceLimit('team'), null);
  assert.equal(getDeviceLimit('enterprise'), null);
});

test('getFlags per tier', () => {
  assert.equal(getFlags('free').shareNotes, false);
  assert.equal(getFlags('starter').shareNotes, true);
  assert.equal(getFlags('starter').teamWorkspaces, false);
  assert.equal(getFlags('team').teamWorkspaces, true);
  assert.equal(getFlags('team').collaborators, true);
  assert.equal(getFlags('team').dashboard, true);
  assert.equal(getFlags('team').audit, false);
  assert.equal(getFlags('enterprise').audit, true);
  assert.equal(getFlags('enterprise').sso, true);
  assert.equal(getFlags('enterprise').selfHosted, true);
});

test('isPaidPlan / isFreePlan', () => {
  assert.ok(isFreePlan('free'));
  assert.ok(!isPaidPlan('free'));
  assert.ok(isPaidPlan('starter'));
  assert.ok(isPaidPlan('team'));
  assert.ok(!isPaidPlan('nonsense'));
});

test('PLAN_OVERRIDE resolves the effective plan', () => {
  process.env.PLAN_OVERRIDE = 'team';
  assert.equal(resolvePlanForAccount({ orgSub: { plan: 'free' }, sub: { plan: 'free' } }), 'team');
  delete process.env.PLAN_OVERRIDE;
});

test('resolvePlanForAccount prefers org plan without override', () => {
  assert.equal(resolvePlanForAccount({ orgSub: { plan: 'team' }, sub: { plan: 'pro' } }), 'team');
  assert.equal(resolvePlanForAccount({ orgSub: null, sub: { plan: 'starter' } }), 'starter');
  assert.equal(resolvePlanForAccount({ orgSub: null, sub: null }), 'free');
});
