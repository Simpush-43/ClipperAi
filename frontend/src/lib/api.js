export async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw Object.assign(new Error(data.error || "Sign in required"), { status: 401 });
  if (response.status === 403) throw Object.assign(new Error(data.error || "Forbidden"), { status: 403 });
  if (response.status === 409) throw Object.assign(new Error(data.error || "Conflict"), { status: 409 });
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
