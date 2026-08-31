const WRITE_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  'X-Tail-Aside': '1',
});

export async function apiRequest(path, options = {}) {
  const requestOptions = { ...options };
  if (requestOptions.body !== undefined) {
    requestOptions.headers = { ...WRITE_HEADERS, ...requestOptions.headers };
  }
  const response = await fetch(path, requestOptions);
  let value;
  try {
    value = await response.json();
  } catch {
    value = {};
  }
  if (!response.ok) {
    const error = new Error(value.error || `tail-aside request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return value;
}

export function getHealth() {
  return apiRequest('/api/health');
}

export function getBrowserTabs() {
  return apiRequest('/api/browser-tabs');
}

export function getThreads(force = false) {
  return apiRequest(force ? '/api/threads?refresh=1' : '/api/threads');
}

export function getThread(threadId) {
  return apiRequest(`/api/threads/${encodeURIComponent(threadId)}`);
}

export function createRun(body) {
  return apiRequest('/api/run', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function cancelRun(runId) {
  return apiRequest(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: '{}',
  });
}
