// Control UI view renders the ACCELERANT cockpit screen.
//
// Functional render helper (no component/shadow DOM). It exposes live ACCELERANT
// status plus run controls without requiring the operator to touch chat, raw
// JSON, run IDs, or the Observer. Status auto-refreshes via polling wired in the
// app shell; this view only renders the current snapshot and emits callbacks.
import { html, nothing } from "lit";
import type { ControlCenterState } from "../controllers/accelerant.ts";

export type AccelerantProps = {
  data: ControlCenterState | null;
  loading: boolean;
  error: string | null;
  apiUrl: string;
  onRefresh: () => void;
  onStartHuntr: () => void;
  onStartGoal: (goal: string) => void;
  onStartBatch: (items: unknown[]) => void;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
  onApprove: (runId: string, grants: string[]) => void;
  onSetApiUrl: (value: string) => void;
};

// Browser-local draft inputs. These intentionally live at module scope (like
// `hostsRevealed` in the instances view) so they survive re-renders without a
// component instance.
let goalDraft = "";
let batchDraft = "";

type StatusTone = "good" | "warn" | "bad" | "neutral";

const FRIENDLY_STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  stalled: "Stalled",
  waiting_for_authority: "Waiting for authority",
  blocked: "Blocked",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
  completed: "Completed",
  live_evidence_pending: "Verifying evidence",
  live_evidence_failed: "Evidence failed",
  objective_won: "Objective won",
};

const STATE_TONES: Record<string, StatusTone> = {
  idle: "neutral",
  running: "good",
  stalled: "warn",
  waiting_for_authority: "warn",
  blocked: "bad",
  failed: "bad",
  stopped: "neutral",
  interrupted: "warn",
  completed: "good",
  live_evidence_pending: "warn",
  live_evidence_failed: "bad",
  objective_won: "good",
};

// Maps a status tone onto the shared `.statusDot` modifier classes.
function toneDotClass(tone: StatusTone): string {
  switch (tone) {
    case "good":
      return "ok";
    case "warn":
      return "warn";
    case "bad":
      return ""; // base .statusDot is danger-colored
    case "neutral":
    default:
      return "muted";
  }
}

function friendlyState(state: string | undefined | null): string {
  if (!state) {
    return "Unknown";
  }
  return FRIENDLY_STATE_LABELS[state] ?? state;
}

function stateTone(state: string | undefined | null): StatusTone {
  if (!state) {
    return "neutral";
  }
  return STATE_TONES[state] ?? "neutral";
}

function yesNo(value: boolean | null | undefined): string {
  if (value === true) {
    return "Yes";
  }
  if (value === false) {
    return "No";
  }
  return "—";
}

function reachableLabel(value: boolean | null | undefined): string {
  if (value === true) {
    return "reachable";
  }
  if (value === false) {
    return "unreachable";
  }
  return "unknown";
}

function formatSeconds(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }
  return `${Math.max(0, Math.round(seconds))}s ago`;
}

function formatTimestamp(value: string | number | null | undefined): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function renderStatCard(label: string, body: unknown) {
  return html`
    <div class="card" style="padding: 12px;">
      <div class="card-sub" style="margin-bottom: 4px;">${label}</div>
      <div>${body}</div>
    </div>
  `;
}

function renderEvidenceLink(url: string | null | undefined) {
  if (!url) {
    return nothing;
  }
  return html`
    <a href=${url} target="_blank" rel="noopener noreferrer" class="muted" style="font-size: 12px;">
      Open evidence details ↗
    </a>
  `;
}

function renderHeader(props: AccelerantProps) {
  const data = props.data;
  const operatorStatus = data?.operatorStatus ?? null;
  const stateName = operatorStatus?.state ?? (data?.nothingRunning ? "idle" : undefined);
  const tone: StatusTone = props.error ? "bad" : stateTone(stateName);
  const label = props.error ? "API unreachable" : friendlyState(stateName);
  const currentRun = data?.currentRun ?? null;

  return html`
    <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
      <div>
        <div class="row" style="gap: 8px; align-items: center;">
          <span class="statusDot ${toneDotClass(tone)}"></span>
          <span class="card-title" style="margin: 0;">${label}</span>
          ${props.loading ? html`<span class="muted" style="font-size: 12px;">refreshing…</span>` : nothing}
        </div>
        ${currentRun?.title
          ? html`<div style="margin-top: 6px;">${currentRun.title}</div>`
          : html`<div class="muted" style="margin-top: 6px;">No active run.</div>`}
        ${currentRun?.runId
          ? html`<div class="muted" style="font-size: 12px; margin-top: 2px;">
              run ${currentRun.runId}
            </div>`
          : nothing}
      </div>
      <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
        <label class="muted" style="font-size: 12px;">ACCELERANT API URL</label>
        <input
          type="text"
          .value=${props.apiUrl}
          placeholder="http://127.0.0.1:7317"
          style="width: 200px;"
          @change=${(event: Event) => {
            const target = event.target as HTMLInputElement;
            props.onSetApiUrl(target.value.trim());
          }}
        />
        <button class="btn" ?disabled=${props.loading} @click=${() => props.onRefresh()}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
    </div>
  `;
}

function renderErrorCallout(props: AccelerantProps) {
  if (!props.error) {
    return nothing;
  }
  return html`
    <div class="callout danger" style="margin-top: 12px;">
      ACCELERANT API unreachable at ${props.apiUrl} — is <code>pnpm api</code> running?
      <div class="muted" style="margin-top: 4px; font-size: 12px;">${props.error}</div>
    </div>
  `;
}

function renderBlockerPanel(props: AccelerantProps) {
  const data = props.data;
  const operatorStatus = data?.operatorStatus ?? null;
  const currentRun = data?.currentRun ?? null;
  const stateName = operatorStatus?.state;
  const isBlocked = stateName === "blocked" || stateName === "waiting_for_authority";
  if (!isBlocked) {
    return nothing;
  }
  const blocker =
    currentRun?.blockers?.[0] ?? operatorStatus?.operatorActionNeeded ?? "Operator action required.";
  const nextSafeAction =
    currentRun?.nextSafeAction ??
    operatorStatus?.operatorActionNeeded ??
    data?.nextSafeActions?.[0] ??
    null;
  const runId = currentRun?.runId ?? null;
  const showApprove = stateName === "waiting_for_authority";

  return html`
    <div class="callout danger" style="margin-top: 16px;">
      <div class="card-title" style="margin: 0;">Blocked — operator action needed</div>
      <div style="margin-top: 6px;">${blocker}</div>
      ${nextSafeAction
        ? html`<div class="muted" style="margin-top: 6px;">Next safe action: ${nextSafeAction}</div>`
        : nothing}
      ${showApprove
        ? html`
            <div class="row" style="gap: 8px; margin-top: 10px;">
              <button
                class="btn primary"
                ?disabled=${!runId}
                @click=${() =>
                  runId && props.onApprove(runId, ["network_access", "final_submission"])}
              >
                Approve final submission
              </button>
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderStatusGrid(props: AccelerantProps) {
  const data = props.data;
  const operatorStatus = data?.operatorStatus ?? null;
  const currentRun = data?.currentRun ?? null;
  const modelStatus = data?.modelStatus ?? null;
  const doctor = data?.openClawDoctor ?? null;
  const browserStatus = data?.browserStatus ?? null;
  const adapters = Array.isArray(data?.challengeAdapters) ? data?.challengeAdapters : [];

  const stage = currentRun?.stage ?? operatorStatus?.currentPhase ?? "—";
  const lastEventType = operatorStatus?.lastEventType ?? "—";
  const lastEventAt = formatTimestamp(operatorStatus?.lastEventAt);
  const heartbeat =
    formatSeconds(operatorStatus?.secondsSinceLastEvent) ?? formatTimestamp(operatorStatus?.lastEventAt);

  const codeGenStatus =
    modelStatus?.codexChildAuthReadiness?.status ?? modelStatus?.codexAuth?.status ?? "—";
  const rubberDuckStatus = doctor?.mcp?.status ?? doctor?.status ?? "—";

  const attemptsSubmitted = operatorStatus?.attemptsSubmitted ?? 0;
  const attemptsUsed = operatorStatus?.attemptsUsed;
  const objectiveWon = operatorStatus?.objectiveWon === true || operatorStatus?.state === "objective_won";

  return html`
    <div
      style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px;"
    >
      ${renderStatCard("Stage", stage)}
      ${renderStatCard(
        "Last event",
        html`
          <div>${lastEventType}</div>
          ${lastEventAt ? html`<div class="muted" style="font-size: 12px;">${lastEventAt}</div>` : nothing}
        `,
      )}
      ${renderStatCard("Heartbeat", heartbeat ?? "—")}
      ${renderStatCard(
        "Model",
        html`
          <div>${modelStatus?.status ?? "—"}</div>
          ${modelStatus?.provider || modelStatus?.model
            ? html`<div class="muted" style="font-size: 12px;">
                ${[modelStatus?.provider, modelStatus?.model].filter(Boolean).join(" · ")}
              </div>`
            : nothing}
        `,
      )}
      ${renderStatCard("CodeGen auth", codeGenStatus)}
      ${renderStatCard("RubberDuck / MCP", rubberDuckStatus)}
      ${renderStatCard(
        "Browser / challenge",
        html`
          <div>${browserStatus?.summary ?? "—"}</div>
          <div class="chip-row" style="margin-top: 6px;">
            <span class="chip">CDP ${reachableLabel(browserStatus?.cdpReachable)}</span>
            <span class="chip">browser ${reachableLabel(browserStatus?.browserReachable)}</span>
            <span class="chip">huntr ${browserStatus?.huntrLoggedIn ? "logged in" : "logged out"}</span>
          </div>
          ${adapters && adapters.length > 0
            ? html`<div class="muted" style="font-size: 12px; margin-top: 6px;">
                ${adapters.length} challenge adapter${adapters.length === 1 ? "" : "s"}
              </div>`
            : nothing}
        `,
      )}
      ${renderStatCard(
        "Attempts submitted",
        attemptsUsed != null
          ? html`${attemptsSubmitted} <span class="muted" style="font-size: 12px;">of ${attemptsUsed}</span>`
          : html`${attemptsSubmitted}`,
      )}
      ${renderStatCard("Score measured", yesNo(operatorStatus?.scoreMeasured))}
      ${renderStatCard("Objective improved", yesNo(operatorStatus?.objectiveImproved))}
      ${renderStatCard(
        "Objective won",
        html`<span class="chip ${objectiveWon ? "chip-ok" : ""}">${yesNo(objectiveWon)}</span>`,
      )}
      ${renderStatCard(
        "Completion",
        html`
          <div>${currentRun?.liveEvidenceStatus ?? "—"}</div>
          ${currentRun?.truthSummary
            ? html`<div class="muted" style="font-size: 12px; margin-top: 4px;">
                ${currentRun.truthSummary}
              </div>`
            : nothing}
        `,
      )}
    </div>
  `;
}

function renderControls(props: AccelerantProps) {
  const runId = props.data?.currentRun?.runId ?? null;
  const hasRun = Boolean(runId);

  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">Controls</div>
      <div class="card-sub">Start, stop, and steer ACCELERANT runs.</div>

      <div class="row" style="gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        <button class="btn primary" @click=${() => props.onStartHuntr()}>
          Start Huntr attempt
        </button>
        <button class="btn" ?disabled=${!hasRun} @click=${() => runId && props.onStop(runId)}>
          Stop run
        </button>
        <button class="btn" ?disabled=${!hasRun} @click=${() => runId && props.onRetry(runId)}>
          Retry run
        </button>
        <button class="btn" ?disabled=${props.loading} @click=${() => props.onRefresh()}>
          Refresh
        </button>
      </div>

      <div style="margin-top: 16px;">
        <div class="card-sub" style="margin-bottom: 4px;">Start custom goal</div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <input
            type="text"
            .value=${goalDraft}
            placeholder="Describe the goal…"
            style="flex: 1; min-width: 240px;"
            @input=${(event: Event) => {
              goalDraft = (event.target as HTMLInputElement).value;
            }}
          />
          <button
            class="btn"
            @click=${() => {
              const goal = goalDraft.trim();
              if (goal) {
                props.onStartGoal(goal);
                goalDraft = "";
              }
            }}
          >
            Start goal
          </button>
        </div>
      </div>

      <div style="margin-top: 16px;">
        <div class="card-sub" style="margin-bottom: 4px;">Start batch (JSON array of items)</div>
        <textarea
          rows="3"
          .value=${batchDraft}
          placeholder='[ { "goal": "…" } ]'
          style="width: 100%; box-sizing: border-box; font-family: monospace;"
          @input=${(event: Event) => {
            batchDraft = (event.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="row" style="gap: 8px; margin-top: 8px;">
          <button
            class="btn"
            @click=${() => {
              const raw = batchDraft.trim();
              if (!raw) {
                return;
              }
              try {
                const parsed: unknown = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                  props.onStartBatch(parsed);
                  batchDraft = "";
                }
              } catch {
                // Leave the draft intact so the operator can fix the JSON.
              }
            }}
          >
            Start batch
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderRecentRuns(props: AccelerantProps) {
  const runs = Array.isArray(props.data?.recentRuns) ? props.data?.recentRuns : [];
  if (!runs || runs.length === 0) {
    return nothing;
  }
  return html`
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">Recent runs</div>
      <div class="list" style="margin-top: 12px;">
        ${runs.map(
          (run) => html`
            <div class="list-item">
              <div class="list-main">
                <div class="list-title">${run.title ?? run.runId ?? "Untitled run"}</div>
                <div class="list-sub">${friendlyState(run.state)}</div>
              </div>
              <div class="list-meta">${renderEvidenceLink(run.observerUrl)}</div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

export function renderAccelerant(props: AccelerantProps) {
  const observerUrl = props.data?.currentRun?.observerUrl ?? null;
  return html`
    <section class="card">
      ${renderHeader(props)} ${renderErrorCallout(props)} ${renderBlockerPanel(props)}
      ${renderStatusGrid(props)}
      ${observerUrl
        ? html`<div style="margin-top: 12px;">${renderEvidenceLink(observerUrl)}</div>`
        : nothing}
    </section>
    ${renderControls(props)} ${renderRecentRuns(props)}
    <div class="muted" style="margin-top: 12px; font-size: 12px;">
      Observer is secondary — everything you need is above.
    </div>
  `;
}
