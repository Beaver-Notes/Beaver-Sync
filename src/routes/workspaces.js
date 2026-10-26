'use strict';

const crypto = require('crypto');
const r2 = require('../services/r2');
const { Account, Workspace, WorkspaceMember, WorkspaceInvite, OrgMember, OrgSubscription, Subscription } = require('../models');
const { createEmptyState } = require('../repositories/syncWorkspaceState');
const { audit } = require('../lib/audit');
const { sendWorkspaceInviteEmail } = require('../email');
const { isFreePlan, resolvePlanForAccount, getFlags } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');
const { resolveOrgSubscription } = require('../lib/plan-resolution');
const { hashSessionId } = require('../lib/crypto');
const { findAccountByUsername } = require('../repositories/account');
const { addRecipientsIfAbsent, listEnvelopes, orderEnvelopes, selectScalarEnvelope } = require('../repositories/workspaceKeys');
const { wrapForRecipient, validatePublicKey } = require('../lib/recipient-wrap');
const { emailVerificationFields } = require('../lib/email-verification');
const { query } = require('../db/postgres');

const EMOJI_ALLOWLIST = Object.freeze([
  '📁', '📂', '🗂️', '📋', '📝', '📄', '📃', '📑', '📦', '🎒',
  '💼', '🗃️', '🗄️', '📊', '📈', '📉', '🧮', '📐', '📏', '✏️',
  '📌', '📍', '🏷️', '🔖', '🏷️', '🗒️', '🗓️', '📅', '📆', '📇',
  '📰', '📜', '📖', '📕', '📗', '📘', '📙', '📚', '📓', '📔',
  '🎯', '🎲', '🎮', '🕹️', '🧩', '🎨', '🖼️', '🎪', '🎭', '🎬',
  '🏠', '🏢', '🏭', '🏫', '🏥', '🏦', '🏛️', '⛪', '🕌', '🕍',
  '⛩️', '🏟️', '🎡', '🎢', '💒', '🏰', '🏯', '🏰', '🗼', '🗽',
  '⭐', '🌟', '✨', '💫', '⚡', '🔥', '💎', '💍', '🏆', '🥇',
  '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎀', '🎁', '🎊', '🎉',
  '🌈', '☀️', '🌤️', '⛅', '🌥️', '☁️', '🌦️', '🌧️', '⛈️', '🌩️',
  '🌨️', '❄️', '☃️', '⛄', '☄️', '🌙', '🌙', '🌛', '🌜', '☀️',
  '🪐', '⭐', '🌌', '🌠', '☄️', '🚀', '🛸', '🛰️', '🌍', '🌎',
  '🌏', '🌐', '🗺️', '🧭', '⛰️', '🏔️', '🌋', '🗻', '🏕️', '⛺',
  '🌲', '🌳', '🌴', '🌵', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃',
  '🍄', '🌾', '💐', '🌷', '🌹', '🥀', '🌺', '🌸', '🌼', '🌻',
  '🌱', '🌿', '🌵', '🎄', '🎋', '🎍', '🎍', '🍂', '🍃', '🍁',
]);

const COLOR_SWATCHES = Object.freeze([
  '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
]);

function validateEmoji(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const trimmed = emoji.trim();
  if (!trimmed) return null;
  if (EMOJI_ALLOWLIST.includes(trimmed)) return trimmed;
  // Accept only single Unicode codepoint emojis (no ZWJ sequences, no skin tone modifiers)
  if (trimmed.length === 1 && /^[\u{1F300}-\u{1FAFF}]$/u.test(trimmed)) return trimmed;
  return null;
}

function validateColor(color) {
  if (!color || typeof color !== 'string') return null;
  const trimmed = color.trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return null;
  if (!COLOR_SWATCHES.includes(trimmed.toLowerCase())) return null;
  return trimmed.toLowerCase();
}

const DEFAULT_EMOJI = EMOJI_ALLOWLIST[0];
const DEFAULT_COLOR = COLOR_SWATCHES[0];

const BODY_LIMIT = parseInt(process.env.WORKSPACE_BODY_LIMIT_BYTES ?? '8192', 10);

async function getMembership(userId, workspaceId) {
  return WorkspaceMember.findOne({ workspaceId, accountId: userId }).lean();
}

async function requireMember(app, userId, workspaceId, allowedRoles) {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    throw Object.assign(new Error('Not a member of this workspace.'), { statusCode: 403, code: 'forbidden' });
  }
  if (allowedRoles && !allowedRoles.has(membership.role)) {
    throw Object.assign(new Error('Insufficient permissions.'), { statusCode: 403, code: 'forbidden' });
  }
  return membership;
}

// Shared workspaces are a team+ capability (plans.js flags.teamWorkspaces:
// starter/pro get a personal workspace only). The workspace's org tier
// governs org workspaces; the workspace owner's tier governs personal
// (org-less) ones. Reads OrgSubscription directly like admin.js
// requirePlanAndOwner — the join caller is not a member yet, so the
// participant-checked resolveOrgSubscription would always miss there.
async function teamWorkspaceAllowed(userId, workspaceId) {
  if (isEnterpriseMode()) return true;
  const ws = await Workspace.findById(workspaceId, { orgId: 1, ownerId: 1 }).lean();
  const orgSub = ws?.orgId ? await OrgSubscription.findOne({ orgId: ws.orgId }).lean() : null;
  // Personal (org-less) workspaces belong to the owner: a joiner on a lower
  // tier must not be blocked from a team owner's workspace, and a joiner on a
  // higher tier must not sneak a starter owner past the gate.
  const tierOwnerId = orgSub ? userId : (ws?.ownerId || userId);
  const sub = await Subscription.findOne({ accountId: tierOwnerId }).lean();
  return getFlags(resolvePlanForAccount({ orgSub, sub })).teamWorkspaces;
}

const rateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.WORKSPACE_RATE_LIMIT_PER_MINUTE ?? '60', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function workspaceRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.post('/', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const { nameEncrypted, recipients, orgId, vaultWrappedKeys, emoji, color } = req.body ?? {};
    if (!nameEncrypted || typeof nameEncrypted !== 'string' || nameEncrypted.length > 8192) {
      return reply.status(400).send({ error: 'validation_error', message: 'Encrypted workspace name is required.' });
    }
    // Optional AEK-wrapped workspace key envelope; stored opaquely so members
    // can recover the key from their vault passphrase alone.
    let normalizedVaultWrappedKeys = null;
    if (vaultWrappedKeys !== undefined && vaultWrappedKeys !== null) {
      if (typeof vaultWrappedKeys !== 'string' || !vaultWrappedKeys || vaultWrappedKeys.length > 8192) {
        return reply.status(400).send({ error: 'validation_error', message: 'vaultWrappedKeys must be a non-empty string.' });
      }
      normalizedVaultWrappedKeys = vaultWrappedKeys;
    }
    if (!Array.isArray(recipients) || recipients.length === 0 || !recipients.some((r) => r.userId === req.userId)) {
      return reply.status(400).send({ error: 'validation_error', message: 'recipients must include the owner.' });
    }
    for (const r of recipients) {
      if (!r || typeof r.userId !== 'string' || typeof r.wrappedKey !== 'string' || !r.wrappedKey) {
        return reply.status(400).send({ error: 'validation_error', message: 'Each recipient needs userId and wrappedKey.' });
      }
      if (r.deviceId !== undefined && (typeof r.deviceId !== 'string' || !r.deviceId)) {
        return reply.status(400).send({ error: 'validation_error', message: 'deviceId must be a non-empty string when provided.' });
      }
    }

    // Validate emoji if provided; optional, defaults to first allowlist glyph
    let validatedEmoji = DEFAULT_EMOJI;
    if (emoji !== undefined) {
      validatedEmoji = validateEmoji(emoji);
      if (!validatedEmoji) {
        return reply.status(400).send({ error: 'validation_error', message: 'Invalid emoji. Must be from allowlist or a single Unicode emoji codepoint.' });
      }
    }

    // Validate color if provided; optional, defaults to first swatch
    let validatedColor = DEFAULT_COLOR;
    if (color !== undefined) {
      validatedColor = validateColor(color);
      if (!validatedColor) {
        return reply.status(400).send({ error: 'validation_error', message: 'Invalid color. Must be a valid hex color from the swatch palette.' });
      }
    }

    if (!isEnterpriseMode()) {
      const sub = await Subscription.findOne({ accountId: req.userId }).lean();
      const orgSub = orgId ? await resolveOrgSubscription(orgId, req.userId) : null;
      const plan = resolvePlanForAccount({ orgSub, sub });

      if (isFreePlan(plan)) {
        return reply.status(403).send({ error: 'plan_upgrade_required', message: 'Cloud workspaces require a paid plan.' });
      }

      if (plan === 'starter' || plan === 'pro') {
        // Count per-org: a shared team workspace the user owns in another org
        // must not block provisioning their personal workspace here.
        const owned = await Workspace.countDocuments({ ownerId: req.userId, orgId });
        if (owned >= 1) {
          return reply.status(403).send({ error: 'workspace_limit_reached', message: 'Your plan includes one personal workspace.' });
        }
      }
    }

    if (!orgId) {
      return reply.status(400).send({ error: 'validation_error', message: 'Organization ID is required.' });
    }

    const membership = await OrgMember.findOne({ org_id: orgId, account_id: req.userId }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_org_member' });
    }

    const workspace = await Workspace.create({ nameEncrypted, ownerId: req.userId, orgId, vaultWrappedKeys: normalizedVaultWrappedKeys, emoji: validatedEmoji, color: validatedColor, createdAt: new Date() });
    await WorkspaceMember.create({ workspaceId: workspace.id, accountId: req.userId, role: 'owner', createdAt: new Date() });

    // Store the owner's (and any supplied) per-device envelopes. Add-only like
    // the late-join path so a workspace key is never rotated.
    await addRecipientsIfAbsent(workspace.id, recipients);

    // Initialize sync state for the new workspace so /sync/state doesn't 404
    await createEmptyState(workspace.id);

    app.log.info({ workspaceId: workspace.id, userId: req.userId }, 'Workspace created');
    audit(req, 'workspace_created', { workspaceId: workspace.id, emoji: validatedEmoji, color: validatedColor });

    return reply.status(201).send({ id: workspace.id, nameEncrypted, role: 'owner', vaultWrappedKeys: normalizedVaultWrappedKeys, emoji: validatedEmoji, color: validatedColor, createdAt: workspace.createdAt });
  });

  // Every account needs somewhere to keep its notes, but the POST / handler
  // above requires a paid plan and an organization (a Team/Enterprise concept),
  // which left a Basic-plan individual with no workspace to share a note from.
  // Provision a personal workspace directly instead: no organization and no plan
  // gate (sync and history keep their own gates), with the owner membership row
  // and empty sync state the rest of the stack expects.
  async function ensureDefaultWorkspace(accountId) {
    const owned = await Workspace.countDocuments({ ownerId: accountId });
    if (owned > 0) return null;
    const existingMembership = await WorkspaceMember.findOne({ accountId }).lean();
    if (existingMembership) return null;

    const workspace = await Workspace.create({
      nameEncrypted: 'Personal',
      ownerId: accountId,
      orgId: null,
      vaultWrappedKeys: null,
      emoji: DEFAULT_EMOJI,
      color: DEFAULT_COLOR,
      createdAt: new Date(),
    });
    await WorkspaceMember.create({
      workspaceId: workspace.id,
      accountId,
      role: 'owner',
      createdAt: new Date(),
    });
    try {
      await createEmptyState(workspace.id);
    } catch (err) {
      app.log.warn({ err, workspaceId: workspace.id }, 'default workspace state init failed');
    }
    // Key provisioning is NOT done here: on every paid signup the workspace was
    // already created during signup, so the guards above short-circuit and this
    // path never runs. provisionSessionWorkspaceKeys covers both cases and keys
    // the envelope to the calling device so selectScalarEnvelope can return it.
    return workspace;
  }

  // The client writes and reads note-key envelopes as {kemCt, iv, ct} with
  // lowercase hex fields, ct holding ciphertext||tag in the WebCrypto
  // convention, so the GCM tag has to be concatenated into ct rather than kept
  // as its own field. wrapForRecipient hands back base64 plus a separate tag;
  // only the encoding changes here, never the key material or ciphertext.
  function toClientEnvelope(envelope) {
    return {
      kemCt: Buffer.from(envelope.kemCt, 'base64').toString('hex'),
      iv: Buffer.from(envelope.iv, 'base64').toString('hex'),
      ct: Buffer.concat([
        Buffer.from(envelope.ct, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
      ]).toString('hex'),
    };
  }

  // The raw workspace key only ever lives in the client's memory, so a workspace
  // is useless until an envelope exists for the device that can unwrap it. For
  // accounts that never had a device identity at signup this repairs every
  // membership on the next GET /workspaces: one query finds the gaps, one wrap
  // per gap writes them, and the helper's ON CONFLICT DO NOTHING keeps repeat
  // calls free. Best effort: key material is optional and must never fail the
  // caller, so failures are logged at error level and swallowed here.
  async function provisionSessionWorkspaceKeys(accountId, sessionDeviceId, workspaceIds) {
    if (!sessionDeviceId || workspaceIds.length === 0) return 0;

    const account = await Account.findById(accountId, { kemPublicKey: 1, deviceKeys: 1 }).lean();
    if (!account) return 0;

    const deviceKeys = Array.isArray(account.deviceKeys) ? account.deviceKeys : [];
    const own = deviceKeys.find(d => d?.deviceId === sessionDeviceId && validatePublicKey(d.publicKey));
    // Fall back to the account-level key only when the account declared no
    // device keys at all; otherwise this device simply is not linked yet and
    // the client will get its envelope via POST /auth/keypair.
    const publicKey = own
      ? own.publicKey
      : (deviceKeys.length === 0 && validatePublicKey(account.kemPublicKey) ? account.kemPublicKey : null);
    if (!publicKey) return 0;

    const { rows: existing } = await query(
      'SELECT workspace_id FROM workspace_keys WHERE user_id = $1 AND device_id = $2',
      [accountId, sessionDeviceId]
    );
    const held = new Set(existing.map(r => r.workspace_id));
    const missing = workspaceIds.filter(id => !held.has(id));
    if (missing.length === 0) return 0;

    let inserted = 0;
    for (const workspaceId of missing) {
      // Mint only for a workspace with no envelopes at all: a second mint would
      // pick a different key than the one already held by other members and
      // split the workspace between them.
      const envelopes = await listEnvelopes(workspaceId);
      if (envelopes.length > 0) {
        app.log.info({ workspaceId }, 'workspace key mint skipped: envelope already exists');
        continue;
      }
      // A fresh key per workspace: never reuse one workspace key across two.
      const workspaceKeyHex = crypto.randomBytes(32).toString('hex');
      inserted += await addRecipientsIfAbsent(workspaceId, [{
        userId: accountId,
        deviceId: sessionDeviceId,
        wrappedKey: JSON.stringify(toClientEnvelope(await wrapForRecipient(publicKey, workspaceKeyHex))),
      }]);
    }
    return inserted;
  }

  app.get('/', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    await ensureDefaultWorkspace(req.userId);
    const memberships = await WorkspaceMember.find({ accountId: req.userId }).lean();
    if (memberships.length === 0) return reply.send({ workspaces: [] });

    const workspaceIds = memberships.map(m => m.workspaceId);
    const roleMap = {};
    for (const m of memberships) roleMap[m.workspaceId] = m.role;

    // Members per workspace: the client needs to know a workspace is shared
    // (>1 member) before it decides how to seal note payloads, so a shared
    // device never mints a key its peers cannot obtain.
    const memberRows = await WorkspaceMember.find({ workspaceId: { $in: workspaceIds } }).lean();
    const memberCounts = new Map();
    for (const m of memberRows) {
      memberCounts.set(m.workspaceId, (memberCounts.get(m.workspaceId) || 0) + 1);
    }

    try {
      await provisionSessionWorkspaceKeys(req.userId, req.sessionDeviceId, workspaceIds);
    } catch (err) {
      app.log.error({ err: err.message || String(err), workspaceIds }, 'workspace key provisioning failed');
    }

    const wsDocs = await Workspace
      .find({ _id: { $in: workspaceIds } }, { _id: 1, nameEncrypted: 1, ownerId: 1, orgId: 1, emoji: 1, color: 1, storageUsedBytes: 1, vaultWrappedKeys: 1, createdAt: 1 })
      .lean();

    const { WorkspaceKey } = require('../models');
    const envelopeRows = await WorkspaceKey.find({ userId: req.userId }).lean();
    const envelopesByWs = new Map();
    for (const e of envelopeRows) {
      const list = envelopesByWs.get(e.workspaceId) || [];
      list.push({ deviceId: e.deviceId ?? null, wrappedKey: e.wrappedKey });
      envelopesByWs.set(e.workspaceId, list);
    }

    const workspaces = [];
    for (const ws of wsDocs) {
      if (!ws) continue;
      const envelopes = orderEnvelopes(envelopesByWs.get(ws.id) || [], req.sessionDeviceId);
      const wrappedKey = selectScalarEnvelope(envelopes, req.sessionDeviceId);
      workspaces.push({
        id: ws.id,
        nameEncrypted: ws.nameEncrypted,
        wrappedKey,
        wrappedKeys: envelopes,
        orgId: ws.orgId,
        emoji: ws.emoji,
        color: ws.color,
        role: roleMap[ws.id],
        ownerId: ws.ownerId,
        memberCount: memberCounts.get(ws.id) ?? 1,
        storageUsedBytes: ws.storageUsedBytes,
        vaultWrappedKeys: ws.vaultWrappedKeys ?? null,
        createdAt: ws.createdAt,
      });
    }

    return reply.send({ workspaces });
  });

  app.patch('/:id', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_workspace_member' });
    }
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return reply.status(403).send({ error: 'insufficient_permissions', message: 'Only owners or admins can update workspaces.' });
    }

    const { nameEncrypted, emoji, color } = req.body ?? {};
    const hasName = nameEncrypted && typeof nameEncrypted === 'string' && nameEncrypted.length > 0 && nameEncrypted.length <= 8192;
    const validatedEmoji = emoji !== undefined ? validateEmoji(emoji) : null;
    const validatedColor = color !== undefined ? validateColor(color) : null;
    const hasEmoji = emoji !== undefined && validatedEmoji !== null;
    const hasColor = color !== undefined && validatedColor !== null;

    if (!hasName && !hasEmoji && !hasColor) {
      return reply.status(400).send({ error: 'validation_error', message: 'At least one of nameEncrypted, emoji, or color is required.' });
    }
    if (emoji !== undefined && !hasEmoji) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid emoji. Must be from allowlist or a single Unicode emoji codepoint.' });
    }
    if (color !== undefined && !hasColor) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid color. Must be a valid hex color from the swatch palette.' });
    }

    const update = {};
    if (hasName) update.nameEncrypted = nameEncrypted;
    if (hasEmoji) update.emoji = validatedEmoji;
    if (hasColor) update.color = validatedColor;

    await Workspace.updateOne({ _id: workspaceId }, { $set: update });

    // Fetch updated workspace to return full state
    const updated = await Workspace.findById(workspaceId, { emoji: 1, color: 1, nameEncrypted: 1 }).lean();

    const action = hasName ? 'workspace_renamed' : 'workspace_decorated';
    app.log.info({ workspaceId, userId: req.userId, ...update }, 'Workspace updated');
    audit(req, action, { workspaceId, ...update });

    return reply.send({ id: workspaceId, nameEncrypted: updated.nameEncrypted, emoji: updated.emoji, color: updated.color });
  });

  app.delete('/:id', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId, role: 'owner' }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_workspace_owner' });
    }

    await WorkspaceMember.deleteMany({ workspace_id: workspaceId });
    await WorkspaceInvite.deleteMany({ workspace_id: workspaceId });
    await Workspace.deleteOne({ _id: workspaceId });

    // Workspace-shared assets (`ws-assets/<wsId>/...`) have no member list or
    // note rows left now, so nothing server-side can serve or prune them from
    // memory; delete the prefix outright (same fire-and-forget as accounts).
    setImmediate(() => {
      r2.listKeys(`ws-assets/${workspaceId}/`)
        .then((keys) =>
          Promise.allSettled(keys.map((key) => r2.del(key)))
        )
        .then((res) =>
          app.log.info({ workspaceId, deletedKeys: res.filter(r => r.status === 'fulfilled').length }, 'Shared asset cleanup complete')
        )
        .catch((err) => app.log.error({ err, workspaceId }, 'Shared asset cleanup failed'));
    });

    app.log.info({ workspaceId, userId: req.userId }, 'Workspace deleted');
    audit(req, 'workspace_deleted', { workspaceId });

    return reply.send({ deleted: true });
  });

  app.post('/:id/members', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    // 02.3: verification is advisory (never enforced by any pipeline); report
    // the state in the success response instead of blocking the invite.
    const inviterAcct = await Account.findById(req.userId, { emailVerified: 1 }).lean();
    const verification = emailVerificationFields(Boolean(inviterAcct?.emailVerified));

    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner', 'editor']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const { username, email, role, ...body } = req.body ?? {};
    if ((!username || typeof username !== 'string') && (!email || typeof email !== 'string')) {
      return reply.status(400).send({ error: 'validation_error', message: 'Provide username or email of the user to invite.' });
    }

    const inviteRole = role === 'viewer' ? 'viewer' : role === 'guest' ? 'guest' : 'editor';

    if (inviteRole === 'guest') {
      return reply.status(400).send({ error: 'invalid_role', message: 'The guest role is no longer supported. Use per-note collaboration instead.' });
    }

    // Plan gate runs after request validation so malformed requests keep
    // their 400 contract regardless of tier.
    if (!await teamWorkspaceAllowed(req.userId, workspaceId)) {
      return reply.status(403).send({
        error: 'plan_upgrade_required',
        message: 'Shared workspaces require a team plan or higher.',
      });
    }

    const requireApproval = body.requireApproval ? 1 : 0;

    let target = null;
    if (username) {
      const normalized = username.trim().toLowerCase();
      const resolved = await findAccountByUsername(normalized);
      if (resolved.ambiguous) {
        return reply.status(409).send({ error: 'ambiguous_username', message: 'Multiple accounts use that username. Invite by email instead.' });
      }
      target = resolved.account;
    } else if (email) {
      const { createEmailHash } = require('../lib/crypto');
      const emailHash = createEmailHash(email.trim().toLowerCase());
      target = await Account.findOne({ emailHmac: emailHash }).lean();
    }

    if (!target) {
      return reply.status(404).send({ error: 'user_not_found', message: 'No user found with that username or email.' });
    }

    if (target.id === req.userId) {
      return reply.status(400).send({ error: 'self_invite', message: 'You cannot invite yourself.' });
    }

    const existing = await WorkspaceMember.findOne({ workspaceId, accountId: target.id }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'already_member', message: 'User is already a member of this workspace.' });
    }

    const { Subscription } = require('../models');
    if (!isEnterpriseMode()) {
      const targetSub = await Subscription.findOne({ accountId: target.id }).lean();
      const targetPlan = targetSub?.plan || 'free';
      if (targetPlan === 'free') {
        return reply.status(403).send({
          error: 'plan_upgrade_required',
          message: 'Free accounts can only be note collaborators, not workspace members.',
        });
      }
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionId(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await WorkspaceInvite.create({
      tokenHash,
      workspaceId,
      role: inviteRole,
      requireApproval,
      expiresAt,
      maxUses: 0,
      usedCount: 0,
      createdAt: new Date(),
    });

    const inviter = await Account.findById(req.userId, { username: 1 }).lean();
    const wsName = await Workspace.findById(workspaceId, { nameEncrypted: 1 }).lean();
    sendWorkspaceInviteEmail(app, target.id, {
      inviterName: inviter?.username || 'Someone',
      workspaceName: wsName?.nameEncrypted || 'a workspace',
      inviteUrl: `${process.env.INVITE_URL_SCHEME ?? 'beaver-notes://'}join/${rawToken}`,
      expiresIn: '7 days',
    });

    app.log.info({ workspaceId, invitedUser: target.id, byUser: req.userId }, 'Workspace invite created');
    audit(req, 'member_added', { workspaceId, targetUserId: target.id, role: inviteRole });

    return reply.status(201).send({
      workspaceId,
      token: rawToken,
      expiresAt,
      role: inviteRole,
      requireApproval: !!requireApproval,
      ...verification,
    });
  });

  app.delete('/:id/members/:uid', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const targetUserId = req.params.uid;

    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    if (targetUserId === req.userId) {
      return reply.status(400).send({ error: 'self_removal', message: 'Owners cannot remove themselves. Transfer ownership first.' });
    }

    const result = await WorkspaceMember.deleteOne({ workspaceId, accountId: targetUserId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    const { WorkspaceKey } = require('../models');
    await WorkspaceKey.deleteMany({ workspaceId, userId: targetUserId });

    // Removing a member from ONE workspace drops the membership only. Sessions
    // are account-scoped (login does not know a workspace), so revoking here
    // would log the member out of every other workspace too. Access is still
    // denied because every workspace route re-checks membership per request.
    // Account-wide revocation happens only on organization removal.

    app.log.info({ workspaceId, removedUser: targetUserId, byUser: req.userId }, 'Member removed from workspace');
    audit(req, 'member_removed', { workspaceId, targetUserId });

    return reply.send({ deleted: true, workspaceId, userId: targetUserId });
  });

  app.post('/join/:token', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const rawToken = req.params.token;
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Invalid invite token.' });
    }

    const tokenHash = hashSessionId(rawToken);
    const invite = await WorkspaceInvite.findOne({ tokenHash }).lean();

    if (!invite) {
      return reply.status(404).send({ error: 'invite_not_found', message: 'Invite not found or already used.' });
    }

    if (new Date(invite.expiresAt) < new Date()) {
      return reply.status(410).send({ error: 'invite_expired', message: 'This invite has expired.' });
    }

    if (invite.maxUses > 0 && invite.usedCount >= invite.maxUses) {
      return reply.status(410).send({ error: 'invite_max_uses', message: 'This invite has reached its maximum number of uses.' });
    }

    const existing = await WorkspaceMember.findOne({ workspaceId: invite.workspaceId, accountId: req.userId }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'already_member', message: 'You are already a member of this workspace.' });
    }

    const joiner = await Account.findById(req.userId, { kemPublicKey: 1 }).lean();
    if (!joiner || !joiner.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: 'Set up end-to-end encryption before joining.' });
    }

    const { Subscription } = require('../models');
    if (!isEnterpriseMode()) {
      const joinerSub = await Subscription.findOne({ accountId: req.userId }).lean();
      if ((joinerSub?.plan || 'free') === 'free') {
        return reply.status(403).send({
          error: 'plan_upgrade_required',
          message: 'Free accounts can only be note collaborators, not workspace members.',
        });
      }
    }

    if (!await teamWorkspaceAllowed(req.userId, invite.workspaceId)) {
      return reply.status(403).send({
        error: 'plan_upgrade_required',
        message: 'Shared workspaces require a team plan or higher.',
      });
    }

    // requireApproval invites are request-access links; the owner must approve
    // explicitly. Record a durable per-account request (mirrors org join
    // requests) so one approval grants only this account; the row's existence
    // is the pending state.
    if (invite.requireApproval) {
      await query(
        `INSERT INTO workspace_join_requests (id, workspace_id, invite_id, account_id, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (invite_id, account_id) DO NOTHING`,
        [crypto.randomUUID(), invite.workspaceId, tokenHash, req.userId, new Date().toISOString()]
      );
      return reply.status(202).send({
        pending: true,
        message: 'This invite link requires the workspace owner to approve you.',
        workspaceId: invite.workspaceId,
        role: invite.role,
      });
    }

    if (invite.maxUses > 0) {
      const upd = await WorkspaceInvite.updateOne({ tokenHash, usedCount: { $lt: invite.maxUses } }, { $inc: { usedCount: 1 } });
      if (upd.modifiedCount === 0) return reply.status(410).send({ error: 'invite_max_uses', message: 'This invite has reached its maximum number of uses.' });
    } else {
      await WorkspaceInvite.updateOne({ tokenHash }, { $inc: { usedCount: 1 } });
    }
    try {
      await WorkspaceMember.create({ workspaceId: invite.workspaceId, accountId: req.userId, role: invite.role, createdAt: new Date() });
    } catch (e) {
      // The membership insert failed: return the consumed use so a transient
      // failure does not burn a limited invite.
      await WorkspaceInvite.updateOne({ tokenHash }, { $inc: { usedCount: -1 } }).catch(() => {});
      if (String(e.message).toLowerCase().includes('unique') || String(e.message).includes('duplicate')) return reply.status(409).send({ error: 'already_member', message: 'You are already a member of this workspace.' });
      throw e;
    }

    app.log.info({ workspaceId: invite.workspaceId, userId: req.userId, role: invite.role }, 'User joined workspace via invite');

    return reply.send({ workspaceId: invite.workspaceId, role: invite.role });
  });

  // Pending workspace join requests the caller (owner/admin) can act on, across
  // every workspace they administer. Feeds the team approval queue.
  app.get('/join-requests', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      `SELECT r.id, r.workspace_id, r.account_id, r.created_at, i.role, a.username
         FROM workspace_join_requests r
         JOIN workspace_invites i ON i.token_hash = r.invite_id
         LEFT JOIN accounts a ON a.id = r.account_id
         JOIN workspace_members m
           ON m.workspace_id = r.workspace_id AND m.account_id = $1 AND m.role IN ('owner', 'admin')
        ORDER BY r.created_at ASC`,
      [req.userId]
    );
    return reply.send({
      requests: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        accountId: r.account_id,
        username: r.username || null,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  });

  // The caller's own outstanding workspace join requests, so the workspace
  // switcher can show "Awaiting owner approval" instead of silently reloading.
  app.get('/my-pending-requests', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      `SELECT r.id, r.workspace_id, r.created_at, i.role
         FROM workspace_join_requests r
         JOIN workspace_invites i ON i.token_hash = r.invite_id
        WHERE r.account_id = $1
        ORDER BY r.created_at ASC`,
      [req.userId]
    );
    return reply.send({
      requests: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  });

  // Pending join requests for one workspace. Owner/admin only: requesters are
  // never revealed to editors, viewers, or outsiders.
  app.get('/:id/join-requests', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner', 'admin']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    const { rows } = await query(
      `SELECT r.id, r.workspace_id, r.account_id, r.created_at, i.role, a.username
         FROM workspace_join_requests r
         JOIN workspace_invites i ON i.token_hash = r.invite_id
         LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.workspace_id = $1
        ORDER BY r.created_at ASC`,
      [workspaceId]
    );
    return reply.send({
      workspaceId,
      requests: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        accountId: r.account_id,
        username: r.username || null,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  });

  // Approve a pending workspace join request: grants the invite's role and
  // consumes the pending row. A second approve finds no row, so no double-grant.
  app.post('/join-requests/:requestId/approve', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      'SELECT id, workspace_id, invite_id, account_id FROM workspace_join_requests WHERE id = $1',
      [req.params.requestId]
    );
    const request = rows[0];
    if (!request) {
      return reply.status(404).send({ error: 'not_found', message: 'Join request not found or already handled.' });
    }
    try {
      await requireMember(app, req.userId, request.workspace_id, new Set(['owner', 'admin']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const { rows: inviteRows } = await query('SELECT role FROM workspace_invites WHERE token_hash = $1', [request.invite_id]);
    const role = inviteRows[0]?.role;
    if (!role) {
      await query('DELETE FROM workspace_join_requests WHERE id = $1', [request.id]);
      return reply.status(404).send({ error: 'not_found', message: 'The invite no longer exists.' });
    }

    if (!await teamWorkspaceAllowed(req.userId, request.workspace_id)) {
      return reply.status(403).send({
        error: 'plan_upgrade_required',
        message: 'Shared workspaces require a team plan or higher.',
      });
    }

    await query(
      `INSERT INTO workspace_members (workspace_id, account_id, role, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [request.workspace_id, request.account_id, role, new Date().toISOString()]
    );
    // Consume every pending request from this account for this workspace.
    await query(
      'DELETE FROM workspace_join_requests WHERE workspace_id = $1 AND account_id = $2',
      [request.workspace_id, request.account_id]
    );

    app.log.info(
      { workspaceId: request.workspace_id, approvedUser: request.account_id, byUser: req.userId, role },
      'Workspace join request approved'
    );
    audit(req, 'member_added', { workspaceId: request.workspace_id, targetUserId: request.account_id, role });
    return reply.send({ approved: true, workspaceId: request.workspace_id, userId: request.account_id, role });
  });

  // Deny a pending workspace join request: drops it without granting access.
  app.post('/join-requests/:requestId/deny', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      'SELECT id, workspace_id, account_id FROM workspace_join_requests WHERE id = $1',
      [req.params.requestId]
    );
    const request = rows[0];
    if (!request) {
      return reply.status(404).send({ error: 'not_found', message: 'Join request not found or already handled.' });
    }
    try {
      await requireMember(app, req.userId, request.workspace_id, new Set(['owner', 'admin']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    await query('DELETE FROM workspace_join_requests WHERE id = $1', [request.id]);
    app.log.info(
      { workspaceId: request.workspace_id, deniedUser: request.account_id, byUser: req.userId },
      'Workspace join request denied'
    );
    return reply.send({ denied: true, workspaceId: request.workspace_id, userId: request.account_id });
  });

  app.get('/:id/member-lookup', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const { email, username } = req.query ?? {};

    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner', 'admin', 'editor']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    let target = null;
    if (username && typeof username === 'string') {
      const normalized = username.trim().toLowerCase();
      const resolved = await findAccountByUsername(normalized);
      if (resolved.ambiguous) {
        return reply.send({ found: false, ambiguous: true });
      }
      target = resolved.account;
    } else if (email && typeof email === 'string') {
      const { createEmailHash } = require('../lib/crypto');
      target = await Account.findOne({ emailHmac: createEmailHash(email.trim().toLowerCase()) }).lean();
    }

    if (!target) {
      return reply.send({ found: false });
    }

    const existing = await WorkspaceMember.findOne({ workspaceId, accountId: target.id }).lean();

    return reply.send({
      found: true,
      accountId: target.id,
      hasKemPublicKey: Boolean(target.kemPublicKey),
      alreadyMember: Boolean(existing),
    });
  });

  app.patch('/:id/members/:uid', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const targetUserId = req.params.uid;

    let actorMembership;
    try {
      actorMembership = await requireMember(app, req.userId, workspaceId, new Set(['owner', 'admin']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const { role } = req.body ?? {};
    if (!['owner', 'admin', 'editor', 'viewer'].includes(role)) {
      return reply.status(400).send({ error: 'invalid_role', message: 'Valid roles: owner, admin, editor, viewer.' });
    }

    const target = await WorkspaceMember.findOne({ workspaceId, accountId: targetUserId }).lean();
    if (!target) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    // Only the current workspace owner may grant the owner role. This keeps an
    // admin from creating a second owner that could never be demoted.
    if (role === 'owner' && actorMembership.role !== 'owner') {
      return reply.status(403).send({ error: 'forbidden', message: 'Only the current workspace owner can grant the owner role.' });
    }

    // No one but the current owner may modify the owner row.
    if (target.role === 'owner' && targetUserId !== req.userId) {
      return reply.status(403).send({ error: 'forbidden', message: 'Only the workspace owner can modify the owner row.' });
    }

    // Self-demotion is only meaningful as part of a transfer, and transfers
    // happen automatically when the owner promotes someone else below.
    if (targetUserId === req.userId && role !== 'owner') {
      return reply.status(400).send({ error: 'cannot_demote_self', message: 'You cannot change your own role away from owner.' });
    }

    // Single-owner invariant: promoting someone else to owner transfers the
    // role, so the current owner steps down to admin. Promote first — if the
    // target row vanished concurrently we must leave the workspace owned, not
    // demote ourselves into an ownerless state.
    if (role === 'owner' && targetUserId !== req.userId) {
      const promoted = await WorkspaceMember.updateOne(
        { workspaceId, accountId: targetUserId },
        { $set: { role: 'owner' } }
      );
      if (promoted.modifiedCount === 0) {
        return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
      }
      const demoted = await WorkspaceMember.updateOne(
        { workspaceId, accountId: req.userId, role: 'owner' },
        { $set: { role: 'admin' } }
      );
      if (demoted.modifiedCount === 0) {
        // Roll the promotion back so we never leave two owners or zero owners.
        await WorkspaceMember.updateOne(
          { workspaceId, accountId: targetUserId, role: 'owner' },
          { $set: { role: target.role } }
        );
        return reply.status(409).send({ error: 'ownership_transfer_conflict', message: 'Ownership transfer could not be completed. Try again.' });
      }

      app.log.info({ workspaceId, targetUserId, role, byUser: req.userId }, 'Workspace member role changed');
      return reply.send({ updated: true });
    }

    const result = await WorkspaceMember.updateOne(
      { workspaceId, accountId: targetUserId },
      { $set: { role } }
    );
    if (result.modifiedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    app.log.info({ workspaceId, targetUserId, role, byUser: req.userId }, 'Workspace member role changed');
    return reply.send({ updated: true });
  });

  app.get('/:id/members', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    try {
      await requireMember(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const members = await WorkspaceMember.find({ workspaceId }).lean();
    const memberIds = members.map((m) => m.accountId);

    const { WorkspaceKey } = require('../models');
    const keys = await WorkspaceKey.find({ workspaceId, userId: { $in: memberIds } }).lean();
    // Per-(user, device) envelopes. Legacy NULL rows are account-level (usable
    // by any device) so they are tracked separately from device-specific ones.
    const deviceWrapped = new Set();
    const legacyWrapped = new Set();
    for (const k of keys) {
      if (k.deviceId == null) legacyWrapped.add(k.userId);
      else deviceWrapped.add(`${k.userId}:${k.deviceId}`);
    }

    const accounts = await Account.find({ _id: { $in: memberIds } }, { id: 1, username: 1, kemPublicKey: 1, deviceKeys: 1 }).lean();
    const accountMap = {};
    for (const a of accounts) accountMap[a._id] = a;

    return reply.send({
      members: members.map((m) => {
        const acct = accountMap[m.accountId];
        const deviceIds = (acct?.deviceKeys && acct.deviceKeys.length)
          ? acct.deviceKeys.map((d) => d.deviceId)
          : ['default'];
        return {
          userId: m.accountId,
          role: m.role,
          // Convenience flag for older callers: an envelope usable in the
          // requesting context (own device, or the account-level legacy one).
          // The authoritative per-device detail is in `devices`.
          hasWrappedKey: legacyWrapped.has(m.accountId)
            || (req.sessionDeviceId != null && deviceWrapped.has(`${m.accountId}:${req.sessionDeviceId}`)),
          devices: deviceIds.map((deviceId) => ({
            deviceId,
            hasEnvelope: deviceWrapped.has(`${m.accountId}:${deviceId}`),
          })),
          hasKeyPair: !!acct?.kemPublicKey,
          kemPublicKey: acct?.kemPublicKey || null,
          username: acct?.username ?? null,
        };
      }),
    });
  });

  app.get('/:id/public-keys', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    try {
      await requireMember(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const members = await WorkspaceMember.find({ workspaceId }).lean();
    const memberIds = members.map((m) => m.accountId);
    const accounts = memberIds.length > 0
      ? await Account.find({ _id: { $in: memberIds } }, { id: 1, kemPublicKey: 1, deviceKeys: 1 }).lean()
      : [];

    // Which (user, device) pairs already hold an envelope, so a key-holding
    // member re-wraps only the devices still missing one. Existence only; no
    // key material is exposed. A legacy account-level row (device_id NULL) is
    // read by any device of that account, so it covers the 'default' device.
    const rows = await listEnvelopes(workspaceId);
    const wrapped = new Set();
    const legacyHolders = new Set();
    const heldDevices = new Map();
    for (const r of rows) {
      if (r.device_id == null) {
        legacyHolders.add(r.user_id);
        continue;
      }
      wrapped.add(`${r.user_id}:${r.device_id}`);
      const set = heldDevices.get(r.user_id) || new Set();
      set.add(r.device_id);
      heldDevices.set(r.user_id, set);
    }

    const collaborators = [];
    for (const a of accounts) {
      const declared = Array.isArray(a.deviceKeys) ? a.deviceKeys.filter((d) => d && d.deviceId) : [];
      // deviceId -> public key. An account with no declared device keys has a
      // single implicit 'default' device, which is where a device-less client
      // stores (and reads back) its envelope.
      const devices = new Map();
      for (const d of declared) devices.set(d.deviceId, d.publicKey ?? null);
      if (devices.size === 0 && a.kemPublicKey) devices.set('default', a.kemPublicKey);
      // A device that holds an envelope but is absent from `device_keys` (its
      // keypair row was replaced, or the envelope was seeded before the device
      // registered) is still a member device: list it so every holder stays
      // discoverable. POST /:id/keys validates membership by userId only, so
      // such a row can legitimately exist.
      for (const deviceId of heldDevices.get(a._id) || []) {
        if (!devices.has(deviceId)) devices.set(deviceId, null);
      }
      if (devices.size === 0) continue;
      for (const [deviceId, publicKey] of devices) {
        collaborators.push({
          userId: a._id,
          deviceId,
          kemPublicKey: publicKey,
          hasEnvelope: wrapped.has(`${a._id}:${deviceId}`)
            || (deviceId === 'default' && legacyHolders.has(a._id)),
        });
      }
    }

    return reply.send({ workspaceId, collaborators });
  });

  app.post('/:id/keys', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    try {
      // Any member who holds the workspace key (owner/admin/editor) can wrap it
      // for a member or device still missing an envelope, so a late joiner no
      // longer depends on the owner/admin being online.
      await requireMember(app, req.userId, workspaceId, new Set(['owner', 'admin', 'editor']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    // Only a member who actually HOLDS the workspace key may wrap it for a
    // member/device still missing an envelope (mirrors the note-key gate in
    // collaboration.js). Writes are add-only, so without this a keyless member
    // could inject a garbage envelope and permanently wedge that device.
    // The workspace's first provisioner (no envelopes yet) is still allowed.
    const existingEnvelopes = await listEnvelopes(workspaceId);
    if (existingEnvelopes.length > 0 && !existingEnvelopes.some((e) => e.user_id === req.userId)) {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Only a member who holds the workspace key can provision envelopes.',
      });
    }

    const body = req.body ?? {};
    // Preferred shape is a per-device list; keep accepting the legacy single
    // {userId, wrappedKey} so older clients still provision.
    let recipients = Array.isArray(body.recipients) ? body.recipients : null;
    if (!recipients && body.userId && body.wrappedKey) {
      recipients = [{ userId: body.userId, deviceId: body.deviceId, wrappedKey: body.wrappedKey }];
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return reply.status(400).send({ error: 'validation_error', message: 'recipients array is required.' });
    }
    if (recipients.length > 200) {
      return reply.status(400).send({ error: 'validation_error', message: 'Too many recipients.' });
    }
    for (const r of recipients) {
      if (!r || typeof r.userId !== 'string' || typeof r.wrappedKey !== 'string' || !r.wrappedKey) {
        return reply.status(400).send({ error: 'validation_error', message: 'Each recipient needs userId and wrappedKey.' });
      }
      if (r.deviceId !== undefined && (typeof r.deviceId !== 'string' || !r.deviceId)) {
        return reply.status(400).send({ error: 'validation_error', message: 'deviceId must be a non-empty string when provided.' });
      }
    }

    const targetIds = [...new Set(recipients.map((r) => r.userId))];
    const targets = await WorkspaceMember.find({ workspaceId, accountId: { $in: targetIds } }).lean();
    const targetSet = new Set(targets.map((m) => m.accountId));
    for (const id of targetIds) {
      if (!targetSet.has(id)) {
        return reply.status(404).send({ error: 'not_found', message: 'Target is not a workspace member.' });
      }
    }

    // Add-only: never overwrite an existing envelope, so a device that already
    // holds the key cannot rotate (split) it. Concurrent provisioners race and
    // the first accepted envelope wins.
    const stored = await addRecipientsIfAbsent(workspaceId, recipients);

    app.log.info({ workspaceId, targetUserIds: targetIds, byUser: req.userId, stored }, 'Workspace keys provisioned');
    audit(req, 'workspace_key_provisioned', { workspaceId, targetUserIds: targetIds });

    return reply.status(201).send({ provisioned: true, stored, existing: stored < recipients.length });
  });
}

module.exports = workspaceRoutes;
