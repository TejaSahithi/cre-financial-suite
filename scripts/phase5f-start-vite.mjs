import { spawn, execFileSync } from "node:child_process";

function parseSupabaseEnv(output) {
  const env = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const statusOutput = execFileSync("supabase", ["status", "-o", "env"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const localEnv = parseSupabaseEnv(statusOutput);

if (!localEnv.API_URL || !localEnv.ANON_KEY) {
  throw new Error("Local Supabase API_URL/ANON_KEY were not available from supabase status -o env.");
}

const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    VITE_SUPABASE_URL: localEnv.API_URL,
    VITE_SUPABASE_ANON_KEY: localEnv.ANON_KEY,
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});