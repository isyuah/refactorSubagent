import { createE2EDashboardServer } from "../src/runtime/e2e-dashboard.js";

interface DashboardCliOptions {
  readonly root: string;
  readonly port: number;
  readonly hostname: string;
}

function usage(): never {
  console.error("用法: bun run scripts/e2e-dashboard.ts --root <e2e-root> --port <port>");
  process.exit(2);
}

function parseOptions(args: readonly string[]): DashboardCliOptions {
  let root: string | null = null;
  let port = 0;
  let hostname = "127.0.0.1";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) usage();
      root = value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || !/^\d+$/.test(value)) usage();
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) usage();
      port = parsed;
      index += 1;
      continue;
    }
    if (arg === "--host" || arg === "--hostname") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) usage();
      hostname = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    usage();
  }

  if (root === null) usage();
  return { root, port, hostname };
}

try {
  const options = parseOptions(Bun.argv.slice(2));
  const server = createE2EDashboardServer(options);
  console.log(`E2E dashboard listening at ${server.url.toString()}`);
  console.log(`观测根目录: ${options.root}`);

  const stop = (): void => {
    server.stop(true);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`E2E dashboard 启动失败: ${message}`);
  process.exitCode = 1;
}
