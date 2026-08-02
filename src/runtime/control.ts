import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { writePrivateFileAtomic } from "../private-file.ts";

export const CONTROL_PROTOCOL_VERSION = 2;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CLIENTS = 16;
const CONNECT_TIMEOUT_MS = 350;
const RESPONSE_TIMEOUT_MS = 30_000;
const STARTUP_LOCK_WAIT_MS = 2_000;
const STARTUP_LOCK_MAX_AGE_MS = 30_000;

export interface RuntimeDescriptor {
  protocolVersion: number;
  kind: "tui" | "service";
  pid: number;
  endpoint: string;
  token: string;
  startedAt: string;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
  token: string;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { kind: string; exitCode: number; hint?: string };
  };
}

export type RuntimeHandler = (
  method: string,
  params: unknown,
) => unknown | Promise<unknown>;

export class RuntimeUnavailableError extends Error {
  constructor(message = "No Spotuify runtime is running.") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export class RuntimeRequestUncertainError extends Error {
  constructor(
    message = "The Spotuify runtime did not confirm the command. It may have completed.",
  ) {
    super(message);
    this.name = "RuntimeRequestUncertainError";
  }
}

export class RuntimeAlreadyRunningError extends Error {
  constructor() {
    super("Another Spotuify runtime is already serving local commands.");
    this.name = "RuntimeAlreadyRunningError";
  }
}

export class RuntimeRemoteError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RuntimeRemoteError";
  }
}

export interface ControlPaths {
  directory: string;
  descriptor: string;
  endpoint: string;
}

export function controlPaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
): ControlPaths {
  // Unix-domain sockets have a short platform limit (104 bytes on macOS). `/tmp` keeps the path
  // bounded; the UID-specific directory is owner-only and the descriptor carries a random token.
  const configured = environment["SPOTUIFY_RUNTIME_DIR"];
  const xdg = environment["XDG_RUNTIME_DIR"];
  const unixFallback = join("/tmp", `spotuify-${uid}`);
  const unixDirectory =
    configured !== undefined && isAbsolute(configured)
      ? configured
      : xdg !== undefined &&
          isAbsolute(xdg) &&
          Buffer.byteLength(join(xdg, "spotuify", "control.sock")) < 100
        ? join(xdg, "spotuify")
        : unixFallback;
  const directory =
    platform === "win32"
      ? join(environment["LOCALAPPDATA"] ?? homedir(), "spotuify", "runtime")
      : unixDirectory;
  const endpoint =
    platform === "win32"
      ? `\\\\.\\pipe\\spotuify-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`
      : join(directory, "control.sock");
  return { directory, descriptor: join(directory, "control.json"), endpoint };
}

async function readDescriptor(path: string): Promise<RuntimeDescriptor> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new RuntimeUnavailableError();
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new RuntimeUnavailableError(
      "The Spotuify runtime descriptor has unsafe permissions.",
    );
  }
  try {
    const value = (await Bun.file(path).json()) as Partial<RuntimeDescriptor>;
    if (
      value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
      (value.kind !== "tui" && value.kind !== "service") ||
      typeof value.pid !== "number" ||
      typeof value.endpoint !== "string" ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      throw new Error("invalid descriptor");
    }
    return value as RuntimeDescriptor;
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) throw error;
    throw new RuntimeUnavailableError(
      "The Spotuify runtime descriptor is invalid.",
    );
  }
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(150, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function rpcCall(
  descriptor: RuntimeDescriptor,
  method: string,
  params: unknown,
  responseTimeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Operation canceled.", "AbortError"),
      );
      return;
    }
    const id = randomUUID();
    const socket = createConnection(descriptor.endpoint);
    let buffer = "";
    let settled = false;
    let dispatched = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const requestFailure = (message?: string): Error =>
      dispatched
        ? new RuntimeRequestUncertainError(message)
        : new RuntimeUnavailableError(message);
    const armTimeout = (milliseconds: number, error: () => Error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(() => finish(error()), milliseconds);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Operation canceled.", "AbortError"),
      );
    signal?.addEventListener("abort", abort, { once: true });
    armTimeout(
      CONNECT_TIMEOUT_MS,
      () =>
        new RuntimeUnavailableError(
          "The Spotuify runtime did not accept a connection.",
        ),
    );
    socket.once("error", () => finish(requestFailure()));
    socket.once("end", () => finish(requestFailure()));
    socket.once("connect", () => {
      const request: RpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
        token: descriptor.token,
      };
      // After this point the server may execute the request even if the response is lost. Never
      // report the runtime as unavailable and replay a mutation through the Web API.
      dispatched = true;
      armTimeout(responseTimeoutMs, () => new RuntimeRequestUncertainError());
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        finish(
          requestFailure(
            "The Spotuify runtime returned an oversized response.",
          ),
        );
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
        if (response.jsonrpc !== "2.0" || response.id !== id)
          throw new Error("invalid response");
        if (response.error !== undefined) {
          const classification = response.error.data;
          finish(
            classification !== undefined &&
              typeof classification.kind === "string" &&
              typeof classification.exitCode === "number"
              ? new RuntimeRemoteError(
                  response.error.message,
                  classification.exitCode,
                  classification.kind,
                  typeof classification.hint === "string"
                    ? classification.hint
                    : undefined,
                )
              : new Error(response.error.message),
          );
        }
        else finish(undefined, response.result);
      } catch {
        finish(
          requestFailure(
            "The Spotuify runtime returned an invalid response.",
          ),
        );
      }
    });
  });
}

export async function runtimeRequest(
  method: string,
  params: unknown = {},
  options: {
    paths?: ControlPaths;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const paths = options.paths ?? controlPaths();
  const descriptor = await readDescriptor(paths.descriptor);
  return await rpcCall(
    descriptor,
    method,
    params,
    options.timeoutMs ?? RESPONSE_TIMEOUT_MS,
    options.signal,
  );
}

export async function tryRuntimeRequest(
  method: string,
  params: unknown = {},
  options: {
    paths?: ControlPaths;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ connected: true; value: unknown } | { connected: false }> {
  try {
    return {
      connected: true,
      value: await runtimeRequest(method, params, options),
    };
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) return { connected: false };
    throw error;
  }
}

function response(
  id: string,
  result?: unknown,
  error?: RpcResponse["error"],
): RpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    ...(error === undefined ? { result } : { error }),
  };
}

function classifiedError(error: unknown): NonNullable<RpcResponse["error"]> {
  const value =
    error !== null && typeof error === "object"
      ? (error as {
          message?: unknown;
          code?: unknown;
          exitCode?: unknown;
          hint?: unknown;
        })
      : null;
  const message =
    value !== null && typeof value.message === "string"
      ? value.message
      : String(error);
  if (
    value !== null &&
    typeof value.code === "string" &&
    typeof value.exitCode === "number"
  ) {
    return {
      code: -32000,
      message,
      data: {
        kind: value.code,
        exitCode: value.exitCode,
        ...(typeof value.hint === "string" ? { hint: value.hint } : {}),
      },
    };
  }
  return { code: -32000, message };
}

async function descriptorIsOwned(
  path: string,
  descriptor: RuntimeDescriptor,
): Promise<boolean> {
  try {
    const current = await readDescriptor(path);
    return safeTokenEqual(current.token, descriptor.token);
  } catch {
    return false;
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function removeOwnedDescriptor(
  paths: ControlPaths,
  descriptor: RuntimeDescriptor,
): Promise<void> {
  if (await descriptorIsOwned(paths.descriptor, descriptor))
    await unlink(paths.descriptor).catch(() => {});
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function prepareRuntimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;

  const pathMetadata = await lstat(directory);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()) {
    throw new Error(
      "The Spotuify runtime directory must be a real directory, not a symlink.",
    );
  }

  // Open the directory itself without following a replacement symlink. Using the file handle for
  // the ownership check and chmod keeps those operations pinned to the object we inspected.
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || (uid !== undefined && metadata.uid !== uid)) {
      throw new Error(
        "The Spotuify runtime directory must be owned by the current user.",
      );
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

interface StartupLockRecord {
  pid: number;
  token: string;
  createdAt: number;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function readStartupLock(path: string): Promise<StartupLockRecord | null> {
  try {
    const value = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<StartupLockRecord>;
    return typeof value.pid === "number" &&
      typeof value.token === "string" &&
      typeof value.createdAt === "number"
      ? (value as StartupLockRecord)
      : null;
  } catch {
    return null;
  }
}

async function acquireStartupLock(
  directory: string,
): Promise<() => Promise<void>> {
  const path = join(directory, "startup.lock");
  const deadline = Date.now() + STARTUP_LOCK_WAIT_MS;

  while (true) {
    const record: StartupLockRecord = {
      pid: process.pid,
      token: randomBytes(32).toString("base64url"),
      createdAt: Date.now(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readStartupLock(path);
        if (current !== null && safeTokenEqual(current.token, record.token)) {
          await unlink(path).catch(() => {});
        }
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }

    const existing = await readStartupLock(path);
    const lockAge =
      existing === null
        ? await stat(path)
            .then((metadata) => Date.now() - metadata.mtimeMs)
            .catch(() => 0)
        : Date.now() - existing.createdAt;
    const ownerMayBeStarting =
      lockAge < STARTUP_LOCK_MAX_AGE_MS &&
      (existing === null || processIsAlive(existing.pid));
    if (ownerMayBeStarting && Date.now() < deadline) {
      await Bun.sleep(20);
      continue;
    }
    if (ownerMayBeStarting) throw new RuntimeAlreadyRunningError();

    // Move a stale claim out of the well-known path atomically. Only the process that acquires a
    // fresh `wx` lock afterward may inspect or remove the stale endpoint.
    const quarantine = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, quarantine);
      await unlink(quarantine).catch(() => {});
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
}

export interface ControlServer {
  readonly descriptor: RuntimeDescriptor;
  publish(): Promise<void>;
  close(): Promise<void>;
}

export async function startControlServer(
  handler: RuntimeHandler,
  options: {
    paths?: ControlPaths;
    kind?: RuntimeDescriptor["kind"];
    publish?: boolean;
  } = {},
): Promise<ControlServer> {
  const paths = options.paths ?? controlPaths();
  await prepareRuntimeDirectory(paths.directory);
  const releaseStartupLock = await acquireStartupLock(paths.directory);

  try {
    let existing;
    try {
      existing = await tryRuntimeRequest("ping", {}, {
        paths,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      // A process that accepted the request owns the endpoint even if it failed to answer in time.
      if (error instanceof RuntimeRequestUncertainError) {
        throw new RuntimeAlreadyRunningError();
      }
      throw error;
    }
    if (existing.connected) throw new RuntimeAlreadyRunningError();
    // A live endpoint without its descriptor still belongs to another process. Never unlink it
    // just because its capability file was removed or became unreadable.
    if (await endpointAcceptsConnections(paths.endpoint)) {
      throw new RuntimeAlreadyRunningError();
    }

    if (process.platform !== "win32") {
      // Startup is serialized by `startup.lock`, so this can only remove an endpoint proven stale
      // while this process owns the atomic claim.
      await unlink(paths.endpoint).catch(() => {});
    }
    // A private startup claim must not leave an old capability file pointing clients at the new,
    // not-yet-initialized server.
    await unlink(paths.descriptor).catch(() => {});

    const descriptor: RuntimeDescriptor = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      kind: options.kind ?? "service",
      pid: process.pid,
      endpoint: paths.endpoint,
      token: randomBytes(32).toString("base64url"),
      startedAt: new Date().toISOString(),
    };
    let clients = 0;
    const server = createServer((socket) => {
      if (clients >= MAX_CLIENTS) {
        socket.destroy();
        return;
      }
      clients++;
      socket.once("close", () => clients--);
      handleSocket(socket, descriptor, handler);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    let publication: Promise<void> | null = null;
    let closePromise: Promise<void> | null = null;
    let closed = false;
    const control: ControlServer = {
      descriptor,
      publish() {
        if (closed) {
          return Promise.reject(
            new RuntimeUnavailableError("The Spotuify runtime is already closed."),
          );
        }
        publication ??= writePrivateFileAtomic(
          paths.descriptor,
          `${JSON.stringify(descriptor, null, 2)}\n`,
        ).catch((error) => {
          publication = null;
          throw error;
        });
        return publication;
      },
      close() {
        closePromise ??= (async () => {
          closed = true;
          await publication?.catch(() => {});
          // net.Server owns removal of its Unix socket as part of close(). Never unlink the
          // endpoint afterward: a successor may already have bound the same path by then.
          await closeServer(server);
          await removeOwnedDescriptor(paths, descriptor);
        })();
        return closePromise;
      },
    };
    if (options.publish !== false) {
      try {
        await control.publish();
      } catch (error) {
        await control.close();
        throw error;
      }
    }
    return control;
  } finally {
    await releaseStartupLock();
  }
}

function handleSocket(
  socket: Socket,
  descriptor: RuntimeDescriptor,
  handler: RuntimeHandler,
): void {
  let buffer = "";
  let handled = false;
  // Disconnects are routine when a caller times out or handles SIGINT while a command is still
  // running. Never let a later response write turn that client lifecycle into a process crash.
  socket.on("error", () => {});
  const send = (value: RpcResponse) => {
    if (socket.destroyed || !socket.writable) return;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.setTimeout(5_000, () => socket.destroy());
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      handled = true;
      send(
        response("", undefined, {
          code: -32001,
          message: "request too large",
        }),
      );
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    void (async () => {
      let request: RpcRequest;
      try {
        request = JSON.parse(buffer.slice(0, newline)) as RpcRequest;
        if (
          request.jsonrpc !== "2.0" ||
          typeof request.id !== "string" ||
          typeof request.method !== "string" ||
          typeof request.token !== "string"
        )
          throw new Error();
      } catch {
        send(
          response("", undefined, {
            code: -32700,
            message: "invalid JSON-RPC request",
          }),
        );
        return;
      }
      if (!safeTokenEqual(request.token ?? "", descriptor.token)) {
        send(
          response(request.id, undefined, {
            code: -32003,
            message: "unauthorized",
          }),
        );
        return;
      }
      // The five-second timer protects only the request-reading/authentication phase. Valid
      // handlers may legitimately wait on Spotify or librespot for as long as the client does.
      socket.setTimeout(0);
      try {
        const result =
          request.method === "ping"
            ? {
                protocolVersion: CONTROL_PROTOCOL_VERSION,
                pid: process.pid,
                kind: descriptor.kind,
                startedAt: descriptor.startedAt,
              }
            : await handler(request.method, request.params);
        send(response(request.id, result));
      } catch (error) {
        send(response(request.id, undefined, classifiedError(error)));
      }
    })();
  });
}
