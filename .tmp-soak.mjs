import { readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
const TOKEN = readFileSync(".runtime/token.txt", "utf8").trim()
const OUT = process.env.TEMP + "\\bws-soak.jsonl"
const LOG = "C:\\Users\\BAOfanTing\\OneDrive\\文档\\Klei\\DoNotStarveTogether\\master_server_log.txt"
writeFileSync(OUT, "")
const samples = []
const start = Date.now()
for (let i = 0; i < 30; i += 1) {
  try {
    const st = await (await fetch("http://127.0.0.1:18788/api/v1/bridge/status?token=" + TOKEN)).json()
    const m = st.sessions.find((s) => s.alive && s.shard === "master")
    let rss = 0
    try { rss = Number(execSync("powershell -NoProfile -Command \"(Get-Process node -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum\"").toString().trim()) } catch {}
    let logSize = 0
    try { logSize = readFileSync(LOG).length } catch {}
    const rec = {
      t: Math.round((Date.now() - start) / 1000),
      connected: st.bridge.connected,
      ack: m ? m.acknowledged_sequence : null,
      hb: m ? m.heartbeats : null,
      tel: m ? m.telemetry_count : null,
      dup: m ? m.duplicates : null,
      gap: m ? m.gaps : null,
      bytes: m ? m.last_payload_bytes : null,
      hbAgo: m ? m.last_heartbeat_ago_ms : null,
      rssMB: Math.round(rss / 1048576 * 10) / 10,
      logMB: Math.round(logSize / 1048576 * 100) / 100,
      queued: st.bridge.queued_commands,
      failedCmds: st.bridge.command_stats?.FAILED ?? null,
      expiredCmds: st.bridge.command_stats?.EXPIRED ?? null,
    }
    samples.push(rec)
    appendFileSync(OUT, JSON.stringify(rec) + "\n")
    console.log(`[${rec.t}s] ack=${rec.ack} hb=${rec.hb} tel=${rec.tel} dup=${rec.dup} gap=${rec.gap} bytes=${rec.bytes} rss=${rec.rssMB}MB log=${rec.logMB}MB failed=${rec.failedCmds} expired=${rec.expiredCmds}`)
  } catch (e) { console.log(`[${i}] 采样失败: ${e.message}`) }
  await new Promise((r) => setTimeout(r, 20000))
}
const last = samples.at(-1), first = samples[0]
console.log("\n=== SOAK SUMMARY ===")
console.log(JSON.stringify({
  samples: samples.length,
  durationS: last.t,
  connectedAll: samples.every((s) => s.connected === true),
  ackFrom: first.ack, ackTo: last.ack,
  hbFrom: first.hb, hbTo: last.hb,
  telFrom: first.tel, telTo: last.tel,
  duplicatesTotal: last.dup, gapsTotal: last.gap,
  payloadMinB: Math.min(...samples.map((s) => s.bytes ?? 1e9)), payloadMaxB: Math.max(...samples.map((s) => s.bytes ?? 0)),
  rssFromMB: first.rssMB, rssToMB: last.rssMB,
  logFromMB: first.logMB, logToMB: last.logMB,
  hbAgoMaxMs: Math.max(...samples.map((s) => s.hbAgo ?? 0)),
  failedCmds: last.failedCmds, expiredCmds: last.expiredCmds,
}, null, 2))
