import crypto from "node:crypto";
import rootPackageJson from "../../../../package.json";
import {
  DeviceType,
  type Device,
  type SmartELifeConfig,
} from "../../../../core/interfaces/smart-elife-config";
import type SmartELifeClient from "../../../../core/smart-elife/smart-elife-client";
import { EXTERIOR_ELEVATOR_DEVICE } from "../../../../core/smart-elife/exterior-devices";
import { ClientResponseCode } from "../../../../core/smart-elife/responses";
import logger from "./logger";

export interface LoginInput {
  username: string;
  password: string;
}

export interface SessionSummary {
  signedIn: boolean;
  requiresPasscode: boolean;
  devices: number;
  lights: number;
}

interface SessionState {
  config?: SmartELifeConfig;
  client?: SmartELifeClient;
  credentials?: LoginInput;
  devices: Device[];
  requiresPasscode: boolean;
  loginPromise?: Promise<void>;
}

const SESSION_KEY = Symbol.for("smart-home-dashboard.smart-elife-session");
const globalSession = globalThis as typeof globalThis & {
  [SESSION_KEY]?: SessionState;
};
const session = globalSession[SESSION_KEY] ?? {
  devices: [],
  requiresPasscode: false,
};
globalSession[SESSION_KEY] = session;

const WALLPAD_VERSION_3_0 = "3.0";

function createSemanticVersion(version: string): SmartELifeConfig["version"] {
  const [baseVersion, betaVersion] = version.split("-beta.");
  const [major = "0", minor = "0", patch = "0"] = baseVersion.split(".");
  const beta = betaVersion === undefined ? -1 : Number.parseInt(betaVersion, 10);

  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    beta: Number.isNaN(beta) ? -1 : beta,
    toString() {
      const base = `${this.major}.${this.minor}.${this.patch}`;
      return this.beta === -1 ? base : `${base}-beta.${this.beta}`;
    },
    isNewerThan(spec: SmartELifeConfig["version"]) {
      const current = [this.major, this.minor, this.patch];
      const next = [spec.major, spec.minor, spec.patch];
      for (let i = 0; i < current.length; i += 1) {
        if (current[i] > next[i]) return true;
        if (current[i] < next[i]) return false;
      }
      if (this.beta === -1 && spec.beta !== -1) return true;
      if (this.beta !== -1 && spec.beta === -1) return false;
      return this.beta !== -1 && spec.beta !== -1 && this.beta > spec.beta;
    },
  };
}

function generateUUID(key: string) {
  return crypto.createHash("md5").update(key).digest("hex").toUpperCase();
}

function sha256(a: string, b: string) {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from(a), Buffer.from(b)])).digest("hex");
}

async function createSmartELifeClient(log: typeof logger, nextConfig: SmartELifeConfig) {
  const { default: Client } = await import("../../../../core/smart-elife/smart-elife-client");
  return Client.createForUI(log, nextConfig);
}

function buildConfig(input: LoginInput): SmartELifeConfig {
  const uuid = process.env.SMART_ELIFE_UUID?.trim()
    || sha256(generateUUID(input.username), "daelim");
  return {
    username: input.username,
    password: input.password,
    uuid,
    wallpadVersion: WALLPAD_VERSION_3_0,
    version: createSemanticVersion(rootPackageJson.version),
    devices: [],
  };
}

async function finalizeSignIn(activeClient: SmartELifeClient, nextConfig: SmartELifeConfig) {
  const version = await activeClient.parseWallPadVersion();
  const fetchedDevices = await activeClient.fetchDevices(true);
  session.devices = [EXTERIOR_ELEVATOR_DEVICE, ...fetchedDevices];
  const activeConfig = { ...nextConfig, wallpadVersion: version, devices: session.devices };
  session.config = activeConfig;
  session.client = activeClient;
  session.requiresPasscode = false;
  return activeConfig;
}

export async function signIn(input: LoginInput) {
  session.client = undefined;
  session.config = undefined;
  session.credentials = undefined;
  session.devices = [];
  session.requiresPasscode = false;

  const nextConfig = buildConfig(input);
  const nextClient = await createSmartELifeClient(logger, nextConfig);

  const response = await nextClient.signIn();
  if (response === ClientResponseCode.UNCERTIFIED_WALLPAD) {
    session.client = nextClient;
    session.config = nextConfig;
    session.credentials = input;
    session.requiresPasscode = true;
    return { ok: false, requiresPasscode: true, code: ClientResponseCode[response] };
  }

  if (response !== ClientResponseCode.SUCCESS) {
    return { ok: false, requiresPasscode: false, code: ClientResponseCode[response] };
  }

  const activeConfig = await finalizeSignIn(nextClient, nextConfig);
  session.credentials = input;
  return {
    ok: true,
    requiresPasscode: false,
    uuid: activeConfig.uuid,
    wallpadVersion: activeConfig.wallpadVersion,
    devices: session.devices.length,
  };
}

export async function authorizePasscode(passcode: string, input?: LoginInput) {
  if (!session.client || !session.config || !session.credentials || !session.requiresPasscode) {
    const credentials = input ?? getEnvironmentLoginInput();
    if (!credentials) {
      return { ok: false, code: "NO_PENDING_AUTHORIZATION" };
    }

    const initialSignIn = await signIn(credentials);
    if (initialSignIn.ok || !initialSignIn.requiresPasscode) {
      return initialSignIn;
    }
  }

  const pendingClient = session.client;
  const pendingCredentials = session.credentials;
  if (!pendingClient || !pendingCredentials) {
    return { ok: false, code: "NO_PENDING_AUTHORIZATION" };
  }

  const response = await pendingClient.authorizeWallpadPasscode(passcode);
  if (response !== ClientResponseCode.SUCCESS) {
    return { ok: false, code: ClientResponseCode[response] };
  }

  return signIn(pendingCredentials);
}

export function getSessionSummary(): SessionSummary {
  return {
    signedIn: Boolean(session.client && !session.requiresPasscode),
    requiresPasscode: session.requiresPasscode,
    devices: session.devices.length,
    lights: session.devices.filter((device) => device.deviceType === DeviceType.LIGHT).length,
  };
}

export async function refreshDevices() {
  await ensureSignedIn();
  const fetchedDevices = await session.client!.fetchDevices(true);
  session.devices = [EXTERIOR_ELEVATOR_DEVICE, ...fetchedDevices];
  if (session.config) {
    session.config = { ...session.config, devices: session.devices };
  }
  return session.devices;
}

export function getLights() {
  return session.devices.filter((device) => device.deviceType === DeviceType.LIGHT);
}

export async function callElevator() {
  await ensureSignedIn();
  const success = await session.client!.sendElevatorCallQuery();
  return { ok: success };
}

export async function setLight(deviceId: string, on: boolean) {
  await ensureSignedIn();
  const device = getLights().find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    return { ok: false, code: "LIGHT_NOT_FOUND" };
  }

  const success = await session.client!.sendDeviceControlOp(device, {
    control: on ? "on" : "off",
  });
  if (success) {
    device.operation = {
      ...device.operation,
      status: on ? "on" : "off",
    };
  }
  return { ok: success, on: success ? on : isDeviceOn(device) };
}

export function getSettings() {
  return {
    provider: "smart-elife",
    storage: "server memory + browser localStorage mappings",
    username: session.credentials?.username ?? "",
    wallpadVersion: session.config?.wallpadVersion ?? "",
    uuid: session.config?.uuid ?? "",
  };
}

export async function initializeFromEnvironment() {
  const configured = Boolean(getEnvironmentLoginInput());
  if (!configured) {
    return { configured: false, signedIn: getSessionSummary().signedIn };
  }

  try {
    await ensureSignedIn();
    return { configured: true, signedIn: true };
  } catch (error) {
    return {
      configured: true,
      signedIn: false,
      error: error instanceof Error ? error.message : "Smart eLife automatic login failed.",
    };
  }
}

async function ensureSignedIn() {
  if (session.client && !session.requiresPasscode) {
    return;
  }

  const credentials = getEnvironmentLoginInput();
  if (!credentials) {
    throw new Error("Smart eLife is not signed in and automatic login is not configured.");
  }

  if (!session.loginPromise) {
    const loginPromise = (async () => {
      const result = await signIn(credentials);
      if (!result.ok) {
        if (result.requiresPasscode) {
          throw new Error("Smart eLife wallpad authorization is required.");
        }
        throw new Error(`Smart eLife automatic login failed (${result.code ?? "UNKNOWN"}).`);
      }
    })();
    session.loginPromise = loginPromise;
    void loginPromise.finally(() => {
      if (session.loginPromise === loginPromise) {
        session.loginPromise = undefined;
      }
    }).catch(() => undefined);
  }

  await session.loginPromise;
}

function getEnvironmentLoginInput(): LoginInput | undefined {
  const username = process.env.SMART_ELIFE_EMAIL?.trim()
    || process.env.SMART_ELIFE_USERNAME?.trim();
  const password = process.env.SMART_ELIFE_PASSWORD ?? "";
  if (!username || !password) {
    return undefined;
  }
  return { username, password };
}

function isDeviceOn(device: Device) {
  const status = String(device.operation?.status ?? "").toLowerCase();
  return status === "on" || status === "1" || status === "true";
}
