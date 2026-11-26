// Shared by the fork scripts: sign and send only to a localhost anvil. Exits with a clear error otherwise.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export async function requireAnvil(rpc, who) {
  let host;
  try { host = new URL(rpc).hostname; } catch { /* below */ }
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`${who}: refusing ${rpc}: FORK_RPC_URL must be a localhost URL (the local anvil fork).`); process.exit(1); }
  let version;
  try {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
    version = (await res.json()).result;
  } catch (e) { console.error(`${who}: cannot reach ${rpc}: ${e.message}`); process.exit(1); }
  if (typeof version !== "string" || !/anvil/i.test(version)) { console.error(`${who}: refusing ${rpc}: web3_clientVersion is ${JSON.stringify(version ?? null)}, not anvil.`); process.exit(1); }
}
