-- 007-workspace-member-roles.postgres.sql
-- Workspace member roles are owner, admin, editor, viewer. The retired 'guest'
-- role (removed in Task 3) is migrated to 'viewer' (also read-only) before the
-- new constraint is installed so existing rows do not fail validation.

UPDATE workspace_members SET role = 'viewer' WHERE role = 'guest';
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'editor', 'viewer'));

UPDATE workspace_invites SET role = 'viewer' WHERE role = 'guest';
ALTER TABLE workspace_invites DROP CONSTRAINT IF EXISTS workspace_invites_role_check;
ALTER TABLE workspace_invites ADD CONSTRAINT workspace_invites_role_check
  CHECK (role IN ('editor', 'viewer'));
