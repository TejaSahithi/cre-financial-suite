/**
 * User Management Service
 *
 * Provides user invitation and role assignment via API.
 */

/**
 * Invite a user by email with a specified role.
 * @param {string} email - Email address to invite.
 * @param {string} role - Role to assign (e.g., "user", "admin").
 */
export async function inviteUser(email, role = 'user') {
  try {
    // TODO: Wire to Supabase Admin API or custom backend endpoint
    const apiUrl = import.meta.env.VITE_API_URL;
    if (apiUrl) {
      const response = await fetch(`${apiUrl}/users/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      if (!response.ok) throw new Error(`Invite failed: ${response.statusText}`);
      return await response.json();
    }
    console.log(`[users] inviteUser(${email}, ${role}) — no backend configured`);
    return { success: true, email, role };
  } catch (err) {
    console.error('[users] inviteUser() error:', err);
    throw err;
  }
}
