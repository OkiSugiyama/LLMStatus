import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("codex", ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "ignore"],
  shell: false,
});

const lines = createInterface({ input: child.stdout });
const timer = setTimeout(() => finish("timeout"), 10_000);

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function shape(message) {
  const safeShape = {
    id: message.id ?? null,
    method: message.method ?? null,
    resultKeys:
      message.result && typeof message.result === "object" ? Object.keys(message.result).sort() : [],
    errorCode: message.error?.code ?? null,
  };
  if (message.id === 2 && message.result) {
    safeShape.requiresOpenaiAuth = message.result.requiresOpenaiAuth ?? null;
    safeShape.hasAccount = message.result.account != null;
    safeShape.accountType = message.result.account?.type ?? null;
  }
  return safeShape;
}

function finish(reason) {
  clearTimeout(timer);
  console.log(JSON.stringify({ finished: reason }));
  lines.close();
  child.kill();
}

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.log(JSON.stringify({ malformed: true }));
    return;
  }
  console.log(JSON.stringify(shape(message)));
  if (message.id === 1) {
    send({ method: "initialized" });
    send({ id: 2, method: "account/read", params: { refreshToken: false } });
  } else if (message.id === 2) {
    send({ id: 3, method: "account/rateLimits/read" });
  } else if (message.id === 3) {
    send({ id: 4, method: "account/usage/read" });
  } else if (message.id === 4) {
    finish("complete");
  }
});

send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "llmstatus-probe", title: "LLMStatus Probe", version: "0.1.0" },
    capabilities: {
      experimentalApi: false,
      optOutNotificationMethods: ["remoteControl/status/changed"],
    },
  },
});
