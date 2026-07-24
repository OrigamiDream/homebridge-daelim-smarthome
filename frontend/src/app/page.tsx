"use client";

import {
  Activity,
  ArrowUp,
  CheckCircle2,
  Home,
  Lightbulb,
  List,
  Lock,
  LogIn,
  PanelRight,
  RefreshCw,
  Settings,
  TerminalSquare,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Device = {
  displayName: string;
  name: string;
  disabled: boolean;
  deviceType: string;
  deviceId: string;
  operation?: Record<string, unknown>;
};

type LogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
};

type Health = {
  ok: boolean;
  session: {
    signedIn: boolean;
    requiresPasscode: boolean;
    devices: number;
    lights: number;
  };
};

type SettingsResponse = {
  settings: {
    provider: string;
    storage: string;
    username: string;
    wallpadVersion: string;
    uuid: string;
  };
};

type DeviceMapping = {
  name?: string;
  hidden?: boolean;
};

const DEVICE_MAPPINGS_KEY = "smart-home.device-mappings";
const tabs = ["Dashboard", "Devices", "Settings", "Logs"] as const;
type Tab = (typeof tabs)[number];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }
  return data;
}

export default function Page() {
  const [activeTab, setActiveTab] = useState<Tab>("Dashboard");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passcode, setPasscode] = useState("");
  const [requiresPasscode, setRequiresPasscode] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<SettingsResponse["settings"] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [lightState, setLightState] = useState<Record<string, boolean>>({});
  const [pendingLights, setPendingLights] = useState<Set<string>>(() => new Set());
  const [deviceMappings, setDeviceMappings] = useState<Record<string, DeviceMapping>>({});

  const mappedDevices = useMemo(
    () =>
      devices.map((device) => {
        const mapping = deviceMappings[device.deviceId];
        return {
          ...device,
          displayName: mapping?.name?.trim() || device.displayName,
          disabled: device.disabled || Boolean(mapping?.hidden),
        };
      }),
    [deviceMappings, devices],
  );
  const lights = useMemo(
    () => mappedDevices.filter((device) => device.deviceType === "light" && !device.disabled),
    [mappedDevices],
  );
  const groups = useMemo(() => {
    return mappedDevices.reduce<Record<string, Device[]>>((acc, device) => {
      acc[device.deviceType] = acc[device.deviceType] ?? [];
      acc[device.deviceType].push(device);
      return acc;
    }, {});
  }, [mappedDevices]);

  async function refresh() {
    const [nextHealth, nextLogs, nextSettings] = await Promise.all([
      api<Health>("/api/health"),
      api<{ logs: LogEntry[] }>("/api/logs"),
      api<SettingsResponse>("/api/settings"),
    ]);
    setHealth(nextHealth);
    setLogs(nextLogs.logs);
    setSettings(nextSettings.settings);
    setSignedIn(nextHealth.session.signedIn);
    setRequiresPasscode(nextHealth.session.requiresPasscode);

    if (nextHealth.session.signedIn) {
      const deviceResponse = await api<{ devices: Device[] }>("/api/devices");
      setDevices(deviceResponse.devices);
      setLightState(
        Object.fromEntries(
          deviceResponse.devices
            .filter((device) => device.deviceType === "light")
            .map((device) => [device.deviceId, isDeviceOn(device)]),
        ),
      );
    } else {
      setDevices([]);
      setLightState({});
    }
  }

  useEffect(() => {
    try {
      const savedMappings = window.localStorage.getItem(DEVICE_MAPPINGS_KEY);
      if (savedMappings) {
        setDeviceMappings(JSON.parse(savedMappings));
      }
    } catch {
      window.localStorage.removeItem(DEVICE_MAPPINGS_KEY);
    }
    refresh().catch(() => undefined);
  }, []);

  function updateDeviceMapping(deviceId: string, patch: DeviceMapping) {
    setDeviceMappings((current) => {
      const next = {
        ...current,
        [deviceId]: {
          ...current[deviceId],
          ...patch,
        },
      };
      window.localStorage.setItem(DEVICE_MAPPINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ ok: boolean; requiresPasscode: boolean; code?: string }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (result.requiresPasscode) {
        setRequiresPasscode(true);
        setMessage("Enter the wallpad passcode to complete authorization.");
      } else if (!result.ok) {
        setMessage(result.code ?? "Smart eLife login failed.");
      } else {
        setSignedIn(true);
        setMessage("Signed in.");
        await refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePasscode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ ok: boolean; code?: string }>("/api/passcode", {
        method: "POST",
        body: JSON.stringify({ passcode, username, password }),
      });
      if (!result.ok) {
        setMessage(result.code ?? "Invalid passcode.");
      } else {
        setRequiresPasscode(false);
        setSignedIn(true);
        setMessage("Wallpad authorized.");
        await refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Passcode failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleElevator() {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ ok: boolean }>("/api/elevator", { method: "POST" });
      setMessage(result.ok ? "Elevator call sent." : "Elevator call failed.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Elevator call failed.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleLight(device: Device) {
    if (pendingLights.has(device.deviceId)) {
      return;
    }
    const next = !lightState[device.deviceId];
    setPendingLights((current) => new Set(current).add(device.deviceId));
    setLightState((current) => ({ ...current, [device.deviceId]: next }));
    try {
      const result = await api<{ ok: boolean; on: boolean }>("/api/light", {
        method: "POST",
        body: JSON.stringify({ deviceId: device.deviceId, on: next }),
      });
      if (!result.ok) {
        setLightState((current) => ({ ...current, [device.deviceId]: !next }));
        setMessage(`Could not update ${device.displayName}.`);
      } else {
        setLightState((current) => ({ ...current, [device.deviceId]: result.on }));
        setDevices((current) =>
          current.map((candidate) =>
            candidate.deviceId === device.deviceId
              ? {
                  ...candidate,
                  operation: {
                    ...candidate.operation,
                    status: result.on ? "on" : "off",
                  },
                }
              : candidate,
          ),
        );
        setMessage(`${device.displayName} ${result.on ? "on" : "off"}.`);
      }
    } catch (error) {
      setLightState((current) => ({ ...current, [device.deviceId]: !next }));
      setMessage(error instanceof Error ? error.message : "Light update failed.");
    } finally {
      setPendingLights((current) => {
        const updated = new Set(current);
        updated.delete(device.deviceId);
        return updated;
      });
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-700 text-white">
              <Home size={22} />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Smart Home</h1>
              <p className="text-sm text-stone-500">Smart eLife dashboard</p>
            </div>
          </div>
          <button
            aria-label="Refresh"
            className="rounded-md border border-stone-300 bg-white p-2 text-stone-700 hover:bg-stone-50"
            onClick={() => refresh().catch((error) => setMessage(String(error)))}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 lg:grid-cols-[220px_1fr]">
        <nav className="flex gap-2 overflow-x-auto lg:block lg:space-y-2">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`min-w-max rounded-md px-3 py-2 text-sm font-medium ${
                activeTab === tab ? "bg-emerald-700 text-white" : "bg-white text-stone-700 hover:bg-stone-50"
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>

        <section className="space-y-4">
          {message ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{message}</div>
          ) : null}

          {!signedIn ? (
            <div className="grid gap-4 md:grid-cols-2">
              <form className="rounded-md border border-stone-200 bg-white p-4" onSubmit={handleLogin}>
                <div className="mb-4 flex items-center gap-2">
                  <LogIn size={18} />
                  <h2 className="font-semibold">Login</h2>
                </div>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-stone-600">Smart eLife email</span>
                  <input
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    type="email"
                    autoComplete="email"
                  />
                </label>
                <label className="mb-4 block text-sm">
                  <span className="mb-1 block text-stone-600">Password</span>
                  <input
                    className="w-full rounded-md border border-stone-300 px-3 py-2"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    autoComplete="current-password"
                  />
                </label>
                <button className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-white disabled:opacity-60" disabled={busy}>
                  <Lock size={16} />
                  Sign in
                </button>
              </form>

              {requiresPasscode ? (
                <form className="rounded-md border border-stone-200 bg-white p-4" onSubmit={handlePasscode}>
                  <div className="mb-4 flex items-center gap-2">
                    <PanelRight size={18} />
                    <h2 className="font-semibold">Wallpad</h2>
                  </div>
                  <label className="mb-4 block text-sm">
                    <span className="mb-1 block text-stone-600">Passcode</span>
                    <input
                      className="w-full rounded-md border border-stone-300 px-3 py-2"
                      value={passcode}
                      onChange={(event) => setPasscode(event.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                  <button className="inline-flex items-center gap-2 rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60" disabled={busy}>
                    <CheckCircle2 size={16} />
                    Authorize
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}

          {signedIn && activeTab === "Dashboard" ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric icon={<Activity size={18} />} label="Session" value={health?.session.signedIn ? "Online" : "Offline"} />
                <Metric icon={<List size={18} />} label="Devices" value={String(health?.session.devices ?? devices.length)} />
                <Metric icon={<Lightbulb size={18} />} label="Lights" value={String(health?.session.lights ?? lights.length)} />
              </div>

              <div className="rounded-md border border-stone-200 bg-white p-4">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-semibold">Elevator</h2>
                  <span className="text-sm text-stone-500">Exterior call</span>
                </div>
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-white disabled:opacity-60"
                  onClick={handleElevator}
                  disabled={busy}
                >
                  <ArrowUp size={16} />
                  Call elevator
                </button>
              </div>

              <div className="rounded-md border border-stone-200 bg-white p-4">
                <h2 className="mb-4 font-semibold">Lights</h2>
                <div className="grid gap-2 md:grid-cols-2">
                  {lights.length ? (
                    lights.map((device) => (
                      <LightRow
                        key={device.deviceId}
                        device={device}
                        checked={Boolean(lightState[device.deviceId])}
                        disabled={pendingLights.has(device.deviceId)}
                        onToggle={() => toggleLight(device)}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-stone-500">No light devices have been discovered yet.</p>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {signedIn && activeTab === "Devices" ? (
            <div className="space-y-3">
              {Object.entries(groups).map(([type, group]) => (
                <div key={type} className="rounded-md border border-stone-200 bg-white p-4">
                  <h2 className="mb-3 font-semibold">{type}</h2>
                  <div className="grid gap-2">
                    {group.map((device) => (
                      <div key={device.deviceId} className="grid gap-3 border-t border-stone-100 py-3 first:border-t-0 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div className="min-w-0">
                          <input
                            aria-label={`Display name for ${device.name}`}
                            className="w-full rounded-md border border-stone-300 px-3 py-2 font-medium"
                            value={deviceMappings[device.deviceId]?.name ?? ""}
                            placeholder={device.displayName}
                            onChange={(event) => updateDeviceMapping(device.deviceId, { name: event.target.value })}
                          />
                          <p className="text-xs text-stone-500">{device.deviceId}</p>
                        </div>
                        <button
                          className={`rounded-md px-3 py-2 text-sm ${
                            device.disabled ? "bg-stone-200 text-stone-700" : "bg-emerald-700 text-white"
                          }`}
                          onClick={() =>
                            updateDeviceMapping(device.deviceId, {
                              hidden: !Boolean(deviceMappings[device.deviceId]?.hidden),
                            })
                          }
                        >
                          {device.disabled ? "Show" : "Visible"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {signedIn && activeTab === "Settings" ? (
            <div className="rounded-md border border-stone-200 bg-white p-4">
              <div className="mb-4 flex items-center gap-2">
                <Settings size={18} />
                <h2 className="font-semibold">Settings</h2>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                {settings
                  ? Object.entries(settings).map(([key, value]) => (
                      <div key={key} className="border-t border-stone-100 pt-3">
                        <dt className="text-stone-500">{key}</dt>
                        <dd className="break-all font-medium">{value || "-"}</dd>
                      </div>
                    ))
                  : null}
              </dl>
            </div>
          ) : null}

          {signedIn && activeTab === "Logs" ? (
            <div className="rounded-md border border-stone-200 bg-white p-4">
              <div className="mb-4 flex items-center gap-2">
                <TerminalSquare size={18} />
                <h2 className="font-semibold">Logs</h2>
              </div>
              <div className="space-y-2">
                {logs.map((entry) => (
                  <div key={`${entry.timestamp}-${entry.message}`} className="rounded-md bg-stone-50 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium uppercase text-stone-700">{entry.level}</span>
                      <time className="text-xs text-stone-500">{new Date(entry.timestamp).toLocaleString()}</time>
                    </div>
                    <p className="mt-1 break-words text-stone-700">{entry.message}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2 text-stone-500">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function LightRow({
  device,
  checked,
  disabled,
  onToggle,
}: {
  device: Device;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2">
      <div>
        <p className="font-medium">{device.displayName}</p>
        <p className="text-xs text-stone-500">{device.deviceId}</p>
      </div>
      <button
        aria-label={`Toggle ${device.displayName}`}
        className={`h-8 w-14 rounded-full p-1 transition disabled:cursor-wait disabled:opacity-60 ${
          checked ? "bg-emerald-700" : "bg-stone-300"
        }`}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className={`block h-6 w-6 rounded-full bg-white transition ${checked ? "translate-x-6" : "translate-x-0"}`} />
      </button>
    </div>
  );
}

function isDeviceOn(device: Device) {
  const status = String(device.operation?.status ?? "").toLowerCase();
  return status === "on" || status === "1" || status === "true";
}
