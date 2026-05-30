import { describe, expect, test, vi } from "vitest";
import { createDaemonApiClient } from "./client";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

const sessionResponse = {
  ok: true,
  session: {
    id: "sess_1",
    mode: "annotate",
    status: "active",
    url: "http://localhost/s/sess_1",
    project: "repo",
    label: "plugin-annotate-plannotator-frontend-plan",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  },
};

describe("getHistory", () => {
  test("hits /daemon/history?project=repo when a name is given", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true, history: [] }),
    );
    const client = createDaemonApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    const result = await client.getHistory("repo");

    expect(result.ok).toBe(true);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/daemon/history?project=repo");
  });

  test("omits the query string when no project is given", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true, history: [] }),
    );
    const client = createDaemonApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    await client.getHistory();

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/daemon/history");
    expect(url).not.toContain("?project=");
  });

  test("rejects a payload missing latestVersionPath", async () => {
    const bad = {
      ok: true,
      history: [{ project: "repo", slug: "s", versionCount: 1, latest: "x" }],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(bad),
    );
    const client = createDaemonApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    const result = await client.getHistory();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-payload");
  });

  test("accepts a well-formed history entry", async () => {
    const good = {
      ok: true,
      history: [
        {
          project: "repo",
          slug: "my-plan-2026-05-29",
          versionCount: 2,
          latest: "2026-05-29T00:00:00.000Z",
          latestVersionPath: "/tmp/repo/my-plan/002.md",
        },
      ],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(good),
    );
    const client = createDaemonApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    const result = await client.getHistory();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.history).toHaveLength(1);
  });
});

describe("createAnnotateSession", () => {
  test("POSTs /daemon/sessions with an annotate request body", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(sessionResponse),
    );
    const client = createDaemonApiClient({ fetch: fetchImpl as unknown as typeof fetch });

    const result = await client.createAnnotateSession("/proj", "/proj/plan.md");

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/daemon/sessions");
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("POST");
    const body = JSON.parse(String(requestInit.body));
    expect(body).toEqual({
      request: {
        action: "annotate",
        origin: "plannotator-frontend",
        cwd: "/proj",
        filePath: "/proj/plan.md",
      },
    });
  });
});
