export const BREAK_GLASS_USER_ID = '0a84ad22-04a1-4778-8c2e-84c87c297461';
export const BREAK_GLASS_EMAIL = 'trust@pehiaweri.local';
export const PORTAL_ROLES = ['Admin', 'Chair', 'Secretary', 'Treasurer', 'Trustee'] as const;

export type PortalRole = (typeof PORTAL_ROLES)[number];

export interface PortalUser {
  userId: string;
  email: string;
  name: string;
  role: PortalRole;
  isBreakGlass: boolean;
}

export function isPortalUser(value: unknown): value is PortalUser {
  if (typeof value !== 'object' || value === null) return false;
  const user = value as Record<string, unknown>;
  return typeof user.userId === 'string' && user.userId.length > 0
    && typeof user.email === 'string' && user.email.length > 0
    && typeof user.name === 'string' && user.name.length > 0
    && PORTAL_ROLES.some((role) => role === user.role)
    && typeof user.isBreakGlass === 'boolean'
    && (!user.isBreakGlass || (user.userId === BREAK_GLASS_USER_ID && user.role === 'Admin'));
}

export function breakGlassAccess(user: { id: string; email?: string }): PortalUser | null {
  if (user.id !== BREAK_GLASS_USER_ID) return null;
  return {
    userId: user.id,
    email: user.email ?? BREAK_GLASS_EMAIL,
    name: 'Trust administrator',
    role: 'Admin',
    isBreakGlass: true,
  };
}
