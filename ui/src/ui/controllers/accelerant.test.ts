import { describe, it, expect, vi } from "vitest";
import { loadAccelerantControlCenter, type AccelerantState } from "./accelerant.ts";

function baseState(over: Partial<AccelerantState> = {}): AccelerantState {
  return {
    settings: {},
    accelerantLoading: false,
    accelerantError: null,
    accelerantData: null,
    ...over,
  } as AccelerantState;
}

describe("accelerant controller auth-candidate retry", () => {
  it("retries /accelerant/control-center with the next credential on 401, then loads data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: "x", operatorState: "completed" }) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // deviceToken is stale; the live session is authenticated via password.
    const state = baseState({ hello: { auth: { deviceToken: "stale-token" } }, password: "fresh-password" });
    await loadAccelerantControlCenter(state);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-password");
    expect(fetchMock.mock.calls[0][1].headers["x-accelerant-base-url"]).toBeTruthy();
    expect(state.accelerantError).toBeNull();
    expect(state.accelerantData).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it("stops on a non-auth error (502) without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: "upstream down" }) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = baseState({ settings: { token: "t1" }, password: "t2" });
    await loadAccelerantControlCenter(state);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.accelerantData).toBeNull();
    // Non-auth error: no retry, and the upstream proxy reason is surfaced.
    expect(state.accelerantError ?? "").toContain("upstream down");

    vi.unstubAllGlobals();
  });

  it("uses the first candidate when it succeeds (no retry)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ summary: "ok" }) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = baseState({ settings: { token: "good" } });
    await loadAccelerantControlCenter(state);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer good");
    expect(state.accelerantData).not.toBeNull();

    vi.unstubAllGlobals();
  });
});
