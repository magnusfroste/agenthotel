const TOKEN_KEY = 'agenthotel_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...options.headers }
  });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
  }
  return res;
}

// fetch only rejects on network failure, so a 4xx/5xx from the panel resolves
// normally and `try { await authFetch(...) } catch` never fires — the caller
// goes on to report success for an operation the backend refused. Most call
// sites already test res.ok themselves; this is for the fire-and-forget ones
// that only care whether it happened. Throws with the backend's own error
// message so the toast says what actually went wrong.
export async function authFetchOk(url, options = {}) {
  const res = await authFetch(url, options);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (_) {
      // Non-JSON body (proxy error page, empty 502) — keep the status message.
    }
    throw new Error(message);
  }
  return res;
}
