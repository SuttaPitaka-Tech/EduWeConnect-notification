/**
 * Chat Permissions & Cross-Organization Eligibility Rules
 *
 * Rules:
 * 1. Staff and Students can ONLY chat with members under their own organization (same organizationId).
 *    They can also chat with Super Admin.
 *    They CANNOT chat with other organizations, nor other organizations' staff or students.
 *
 * 2. Organization (Institution Admin) can chat with:
 *    - Super Admin
 *    - Anyone under their own organization (staff, teachers, students)
 *    - Another Organization Head (other institution admins)
 *    Organization CANNOT chat with other organizations' staff or students.
 *
 * 3. Super Admin can chat with everyone.
 */

export interface ChatActor {
  id: string;
  role: string;
  organizationId?: string | null;
}

export interface ChatTarget {
  id?: string;
  userId?: string;
  role: string;
  organizationId?: string | null;
}

export const normalizeRole = (role?: string): string => {
  if (!role) return 'member';
  const r = role.toLowerCase().trim().replace(/[_-]/g, ' ');
  if (r.includes('super')) return 'super_admin';
  if (r.includes('institution') || r.includes('organization') || (r.includes('admin') && !r.includes('super'))) {
    return 'institution_admin';
  }
  if (r.includes('teacher') || r.includes('staff') || r.includes('faculty')) return 'staff';
  if (r.includes('student')) return 'student';
  if (r.includes('parent')) return 'parent';
  return 'member';
};

export const ROLE_HIERARCHY_WEIGHT: Record<string, number> = {
  super_admin: 1,
  institution_admin: 2,
  staff: 3,
  student: 4,
  parent: 5,
  member: 6,
};

/**
 * Validates whether two users are permitted to chat directly
 */
export const canUsersChat = (sender: ChatActor, target: ChatTarget): boolean => {
  const senderRole = normalizeRole(sender.role);
  const targetRole = normalizeRole(target.role);
  const targetId = target.userId || target.id;

  // Cannot chat with oneself directly as another user
  if (sender.id && targetId && sender.id === targetId) {
    return true;
  }

  // 1. Super Admin can chat with anyone
  if (senderRole === 'super_admin' || targetRole === 'super_admin') {
    return true;
  }

  const senderOrg = sender.organizationId?.toString().trim();
  const targetOrg = target.organizationId?.toString().trim();

  // 2. Members under the same organization can always chat with each other
  if (senderOrg && targetOrg && senderOrg === targetOrg) {
    return true;
  }

  // 3. Organization Head to Organization Head exception:
  // An Institution Admin can chat with another Institution Admin across organizations
  if (senderRole === 'institution_admin' && targetRole === 'institution_admin') {
    return true;
  }

  // 4. In all other cross-organization cases, chat is disallowed:
  // - Staff/Student cannot chat across organizations
  // - Organization cannot chat with other organizations' staff or students
  return false;
};

/**
 * Sorts contacts / members by strict role priority:
 * 1. Super Admin
 * 2. Organization / Institution Admin
 * 3. Staff / Teacher
 * 4. Student
 */
export const sortContactsByRoleHierarchy = <T extends { role?: string; name?: string }>(contacts: T[]): T[] => {
  return [...contacts].sort((a, b) => {
    const roleA = normalizeRole(a.role);
    const roleB = normalizeRole(b.role);
    const weightA = ROLE_HIERARCHY_WEIGHT[roleA] || 99;
    const weightB = ROLE_HIERARCHY_WEIGHT[roleB] || 99;

    if (weightA !== weightB) {
      return weightA - weightB;
    }

    return (a.name || '').localeCompare(b.name || '');
  });
};
