// Upstash Redis over its REST API, which is what Vercel's Marketplace
// "Upstash for Redis" store provides (it sets KV_REST_API_URL and
// KV_REST_API_TOKEN on the project). Plain fetch, so no SDK dependency.
export function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

// One Redis command, e.g. ["GET", key] or ["SET", key, value, "EX", "60"].
export async function kvCommand(config, command) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Storage request failed (${response.status}).`);
  }
  return payload.result;
}

// Several commands in one round trip (Upstash's /pipeline). Returns each
// command's result in order; a failed command throws.
export async function kvPipeline(config, commands) {
  const response = await fetch(`${config.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(payload?.error || `Storage request failed (${response.status}).`);
  }
  const failed = payload.find((item) => item?.error);
  if (failed) throw new Error(failed.error);
  return payload.map((item) => item.result);
}
