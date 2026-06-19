// Control UI controller manages ACCELERANT cockpit state.
//
// Unlike the gateway-backed controllers (which use a WS client), the ACCELERANT
// cockpit talks to a local ACCELERANT API over a SAME-ORIGIN HTTP proxy mounted
// by the gateway at /accelerant/. The browser must never call the loopback
// ACCELERANT API directly (no CORS), so every request goes through the proxy
// and carries the configured base URL via the `x-accelerant-base-url` header
// plus the existing gateway auth header.
import { resolveControlUiAuthCandidates } from "../control-ui-auth.ts";

const ACCELERANT_BASE_URL_HEADER = "x-accelerant-base-url";
const DEFAULT_ACCELERANT_BASE_URL = "http://127.0.0.1:7317";

// Overall operator state surfaced by the control-center payload. Kept as a
// string-typed union for friendly labels/colors, but treated defensively at
// the call site (the API may report a state we do not yet model).
export type AccelerantOperatorStateName =
  | "idle"
  | "running"
  | "stalled"
  | "waiting_for_authority"
  | "blocked"
  | "failed"
  | "stopped"
  | "interrupted"
  | "completed"
  | "live_evidence_pending"
  | "live_evidence_failed"
  | "objective_won";

export type AccelerantOperatorStatus = {
  state?: AccelerantOperatorStateName | string;
  currentPhase?: string | null;
  lastEventType?: string | null;
  lastEventAt?: string | number | null;
  secondsSinceLastEvent?: number | null;
  operatorActionNeeded?: string | null;
  attemptsSubmitted?: number | null;
  attemptsUsed?: number | null;
  scoreMeasured?: boolean | null;
  objectiveImproved?: boolean | null;
  objectiveWon?: boolean | null;
};

export type AccelerantCurrentRun = {
  runId?: string | null;
  title?: string | null;
  stage?: string | null;
  blockers?: string[] | null;
  nextSafeAction?: string | null;
  liveEvidenceStatus?: "pass" | "fail" | "unknown" | string | null;
  truthSummary?: string | null;
  observerUrl?: string | null;
};

export type AccelerantModelStatus = {
  status?: string | null;
  provider?: string | null;
  model?: string | null;
  codexChildAuthReadiness?: { status?: string | null } | null;
  codexAuth?: { status?: string | null } | null;
};

export type AccelerantOpenClawDoctor = {
  status?: string | null;
  mcp?: { status?: string | null } | null;
};

export type AccelerantBrowserStatus = {
  summary?: string | null;
  cdpReachable?: boolean | null;
  huntrLoggedIn?: boolean | null;
  browserReachable?: boolean | null;
};

export type AccelerantChallengeAdapter = {
  id?: string | null;
  name?: string | null;
  summary?: string | null;
  ready?: boolean | null;
};

export type AccelerantRecentRun = {
  runId?: string | null;
  title?: string | null;
  state?: string | null;
  observerUrl?: string | null;
};

// The control-center payload the cockpit consumes. Every field is optional and
// read defensively — the ACCELERANT API may omit fields depending on state.
export type ControlCenterState = {
  operatorStatus?: AccelerantOperatorStatus | null;
  nothingRunning?: boolean | null;
  currentRun?: AccelerantCurrentRun | null;
  modelStatus?: AccelerantModelStatus | null;
  openClawDoctor?: AccelerantOpenClawDoctor | null;
  browserStatus?: AccelerantBrowserStatus | null;
  challengeAdapters?: AccelerantChallengeAdapter[] | null;
  nextSafeActions?: string[] | null;
  recentRuns?: AccelerantRecentRun[] | null;
};

// Minimal auth-header source: mirrors `ControlUiAuthSource` so we can reuse the
// shared resolver, plus the configured ACCELERANT base URL setting.
export type AccelerantState = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  password?: string | null;
  settings: { token?: string; accelerantApiUrl?: string };
  accelerantLoading: boolean;
  accelerantError: string | null;
  accelerantData: ControlCenterState | null;
  requestUpdate?: () => void;
};

function resolveAccelerantBaseUrl(state: AccelerantState): string {
  const configured = state.settings.accelerantApiUrl?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_ACCELERANT_BASE_URL;
}

// Same-origin /accelerant fetch with auth-candidate retry. Tries the control-UI
// shared-secret candidates (deviceToken, settings.token, password) in priority
// order and retries on 401/403 — mirrors loadControlUiBootstrapConfig so the
// ACCELERANT tab recovers when the first credential is stale but the live session
// is authenticated via another. Always carries the base-URL routing header. Falls
// back to a single unauthenticated attempt on auth-disabled deployments.
async function accelerantFetch(
  state: AccelerantState,
  path: string,
  init: { method: string; body?: string; extraHeaders?: Record<string, string> },
): Promise<Response> {
  const candidates = resolveControlUiAuthCandidates(state);
  const attempts = candidates.length > 0 ? candidates : [""];
  let response: Response | null = null;
  for (const candidate of attempts) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [ACCELERANT_BASE_URL_HEADER]: resolveAccelerantBaseUrl(state),
      ...(init.extraHeaders ?? {}),
      ...(candidate ? { Authorization: `Bearer ${candidate}` } : {}),
    };
    response = await fetch(path, {
      method: init.method,
      headers,
      credentials: "same-origin",
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    if (response.ok || (response.status !== 401 && response.status !== 403)) {
      break;
    }
  }
  return response as Response;
}

function notify(state: AccelerantState): void {
  state.requestUpdate?.();
}

// Coerce an unknown error/response into a short, human-readable string without
// leaking objects into the UI.
function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  return "ACCELERANT API unreachable";
}

function isControlCenterState(value: unknown): value is ControlCenterState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pull a string `error` field out of a parsed JSON body if present; otherwise
// fall back to a status-coded message. The proxy returns `{ error, baseUrl }`
// on 502/4xx, so this surfaces the upstream reason when available.
function extractErrorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const errorValue = (body as { error?: unknown }).error;
    if (typeof errorValue === "string" && errorValue.trim()) {
      return errorValue.trim();
    }
  }
  return `ACCELERANT API unreachable (${status})`;
}

/**
 * GET /accelerant/control-center through the same-origin proxy and store the
 * payload on `state.accelerantData`. On any failure (network, non-2xx, bad
 * body) clears the data and sets a friendly `state.accelerantError`.
 */
export async function loadAccelerantControlCenter(state: AccelerantState): Promise<void> {
  state.accelerantLoading = true;
  state.accelerantError = null;
  notify(state);
  try {
    const response = await accelerantFetch(state, "/accelerant/control-center", { method: "GET" });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      state.accelerantData = null;
      state.accelerantError = extractErrorMessage(body, response.status);
      return;
    }
    if (!isControlCenterState(body)) {
      state.accelerantData = null;
      state.accelerantError = "ACCELERANT API returned an unexpected payload";
      return;
    }
    state.accelerantData = body;
    state.accelerantError = null;
  } catch (err) {
    state.accelerantData = null;
    state.accelerantError = describeError(err);
  } finally {
    state.accelerantLoading = false;
    notify(state);
  }
}

/**
 * Shared POST helper: forwards a JSON body to the proxy, surfaces a friendly
 * error on failure, then refreshes the control-center so the UI reflects the
 * new state without the operator needing to hit Refresh.
 */
async function postAndRefresh(
  state: AccelerantState,
  path: string,
  body: unknown,
): Promise<void> {
  state.accelerantError = null;
  notify(state);
  let postError: string | null = null;
  try {
    const response = await accelerantFetch(state, path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      extraHeaders: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as unknown;
      const fallback = `ACCELERANT API unreachable (${response.status})`;
      const detail = extractErrorMessage(parsed, response.status);
      postError = detail === fallback ? `ACCELERANT request failed (${response.status})` : detail;
    }
  } catch (err) {
    postError = describeError(err);
  } finally {
    // Refresh resets accelerantError; if the action itself failed but the
    // refresh succeeded, surface the action's error rather than hiding it.
    await loadAccelerantControlCenter(state);
    if (postError && !state.accelerantError) {
      state.accelerantError = postError;
      notify(state);
    }
  }
}

export async function startHuntrAttempt(state: AccelerantState): Promise<void> {
  await postAndRefresh(state, "/accelerant/control-center/huntr-attempt", {});
}

export async function startCustomGoal(state: AccelerantState, goal: string): Promise<void> {
  await postAndRefresh(state, "/accelerant/goals", { goal });
}

export async function startBatch(state: AccelerantState, items: unknown[]): Promise<void> {
  await postAndRefresh(state, "/accelerant/control-center/batches", { items });
}

export async function stopRun(
  state: AccelerantState,
  runId: string,
  reason?: string,
): Promise<void> {
  await postAndRefresh(
    state,
    `/accelerant/runs/${encodeURIComponent(runId)}/stop`,
    reason ? { reason } : {},
  );
}

export async function retryRun(state: AccelerantState, runId: string): Promise<void> {
  await postAndRefresh(state, `/accelerant/runs/${encodeURIComponent(runId)}/retry`, {});
}

export async function approveRun(
  state: AccelerantState,
  runId: string,
  grants: string[],
): Promise<void> {
  await postAndRefresh(state, `/accelerant/runs/${encodeURIComponent(runId)}/approve`, { grants });
}
