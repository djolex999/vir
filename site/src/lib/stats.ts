export interface Stats {
  downloadsWeek: number | null;
  stars: number | null;
}

const NPM_DOWNLOADS =
  "https://api.npmjs.org/downloads/point/last-week/@djolex999%2Fvir-cli";
const GITHUB_REPO = "https://api.github.com/repos/djolex999/vir";
const TIMEOUT_MS = 5000;

async function readNumber(
  doFetch: typeof fetch,
  url: string,
  key: string,
): Promise<number | null> {
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "vir-site-build" },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

// Build-time only. A failed API call omits the figure; it never fails the build.
export async function fetchStats(doFetch: typeof fetch = fetch): Promise<Stats> {
  const [downloadsWeek, stars] = await Promise.all([
    readNumber(doFetch, NPM_DOWNLOADS, "downloads"),
    readNumber(doFetch, GITHUB_REPO, "stargazers_count"),
  ]);
  return { downloadsWeek, stars };
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const k = (n / 1000).toFixed(1).replace(/\.0$/, "");
  return `${k}k`;
}
