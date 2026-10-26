// Fake daemon client for smoke tests: connect to a bridge control socket and
// exercise the protocol. Usage: node link-client.mjs <socket> [--submit]
import net from "node:net";
import fs from "node:fs";

const sock = process.argv[2];
const doSubmit = process.argv.includes("--submit");
const deadline = Date.now() + 15000;
while (!fs.existsSync(sock)) {
  if (Date.now() > deadline) {
    console.log("FAIL: socket never appeared");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
const c = net.createConnection(sock);
let buf = "";
const pending = new Map();
let failed = false;
c.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    if (msg.type === "event") {
      if (!["message_update"].includes(msg.data.type))
        console.log("  event:", msg.data.type);
    } else {
      const ok = msg.ok ? "OK" : `ERR(${msg.error})`;
      console.log(`  ${msg.id}: ${ok} dispatch=${msg.dispatch ?? "-"}`);
      if (!msg.ok && ["r1", "m", "s1"].includes(msg.id)) failed = true;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  }
});
const ask = (id, obj) =>
  new Promise((r) => {
    pending.set(id, r);
    c.write(JSON.stringify({ id, ...obj }) + "\n");
  });
await new Promise((r) => c.on("connect", r));

await ask("a", { type: "startup" });
const st = await ask("r1", { type: "state" });
await ask("m", { type: "models" });
const sid = st.result.sessionId;
await ask("cfg", { type: "configure", sessionId: sid, thinking: "high", operationId: "cf1" });
await ask("h", { type: "history", sessionId: sid });
await ask("bad", { type: "bogus", sessionId: sid });
if (doSubmit) {
  await ask("s1", { type: "submit", sessionId: sid, text: "Reply with exactly: bridge-ok", operationId: "op1", mode: "steer" });
  await new Promise((r) => setTimeout(r, 90000));
  await ask("h2", { type: "history", sessionId: sid });
}
c.end();
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
