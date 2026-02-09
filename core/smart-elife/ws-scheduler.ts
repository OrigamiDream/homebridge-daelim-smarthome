import WebSocket from "ws";
import {LoggerBase, Utils} from "../utils";
import {ClientResponseCode} from "./responses";
import {Logging} from "homebridge";
import SmartELifeClient from "./smart-elife-client";
import {DeviceType} from "../interfaces/smart-elife-config";

export interface WebSocketInjector {
    getJSessionId(client: SmartELifeClient): string | undefined;
    onRefresh(client: SmartELifeClient): Promise<ClientResponseCode>;
    onResilient(client: SmartELifeClient): Promise<ClientResponseCode>;
}

export type Listener = (data: any) => void;

interface ListenerInfo {
    deviceType: DeviceType
    listener: Listener
}

export default class WebSocketScheduler {

    private ws?: WebSocket;
    private wsReconnectTimer?: NodeJS.Timeout;
    private wsReconnectAttempt: number = 0;
    private wsConnecting: boolean = false;
    private wsClosedByUser: boolean = false;
    private wsLastAuthRefreshAtMs: number = 0;
    private wsConnectPromise?: Promise<void>;

    private readonly listeners: ListenerInfo[] = [];

    constructor(
        private readonly client: SmartELifeClient,
        private readonly baseUrl: string,
        private readonly log: Logging | LoggerBase,
        private readonly injector: WebSocketInjector) {
    }

    private getWebSocketUrl(): string {
        const url = new URL(this.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        // The Smart eLife web client connects to `/ws/data` on the same origin.
        url.pathname = "/ws/data";
        url.search = "";
        url.hash = "";
        return url.toString();
    }

    private getWebSocketHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "User-Agent": Utils.SMART_ELIFE_USER_AGENT,
            "Origin": this.baseUrl,
        };
        const jsessionId = this.injector.getJSessionId(this.client);
        if(jsessionId) {
            headers["Cookie"] = `JSESSIONID=${jsessionId}`;
        }
        return headers;
    }

    private clearWebSocketReconnectTimer() {
        if(this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = undefined;
        }
    }

    private scheduleWebSocketReconnect(reason: string) {
        if(this.wsClosedByUser) {
            return;
        }
        this.clearWebSocketReconnectTimer();

        const attempt = Math.min(this.wsReconnectAttempt, 6);
        const delayMs = Math.min(60_000, 1_000 * Math.pow(2, attempt));
        this.wsReconnectAttempt += 1;

        this.log.warn(`[WebSocket] reconnect scheduled in ${Math.round(delayMs / 1000)}s (${reason})`);
        this.wsReconnectTimer = setTimeout(() => {
            void this.connectWebSocket().catch((e) => {
                this.log.error(`[WebSocket] reconnect attempt failed: ${(e as any)?.message || e}`);
            });
        }, delayMs);
    }

    private static wsRawDataToString(data: WebSocket.RawData): string {
        if(Buffer.isBuffer(data)) {
            return data.toString("utf8");
        }
        if(Array.isArray(data)) {
            return Buffer.concat(data).toString("utf8");
        }
        // ArrayBuffer
        return Buffer.from(data).toString("utf8");
    }

    private async waitForWebSocketOpen(ws: WebSocket, timeoutMs: number = 10_000): Promise<void> {
        if(ws.readyState === WebSocket.OPEN) {
            return;
        }
        if(ws.readyState !== WebSocket.CONNECTING) {
            throw new Error(`WebSocket is not open (readyState=${ws.readyState}).`);
        }

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => cleanup(() => reject(new Error("WebSocket open timeout."))), timeoutMs);

            const onOpen = () => cleanup(resolve);
            const onError = (err: Error) => cleanup(() => reject(err));
            const onClose = (code: number) => cleanup(() => reject(new Error(`WebSocket closed before open (code=${code}).`)));

            const cleanup = (fn: () => void) => {
                clearTimeout(timer);
                ws.off("open", onOpen);
                ws.off("error", onError);
                ws.off("close", onClose);
                fn();
            };

            ws.on("open", onOpen);
            ws.on("error", onError);
            ws.on("close", onClose);
        });
    }

    public addListener(deviceType: DeviceType, listener: Listener) {
        this.listeners.push({ deviceType, listener });
    }

    public async wsSendJson(payload: any): Promise<void> {
        await this.connectWebSocket();
        const ws = this.ws;
        if(!ws) {
            return;
        }
        await this.waitForWebSocketOpen(ws, 10_000);

        await new Promise<void>((resolve, reject) => {
            this.log.debug(`[WebSocket] :: Send :: ${JSON.stringify(payload)}`)
            ws.send(JSON.stringify(payload), (err?: Error) => {
                if(err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private async refreshAuthForWebSocket() {
        const now = Date.now();
        // Avoid hammering sign-in when server repeatedly drops the connection.
        if(now - this.wsLastAuthRefreshAtMs < 15_000) {
            return;
        }
        this.wsLastAuthRefreshAtMs = now;

        const response = await this.injector.onRefresh(this.client);
        if(response !== ClientResponseCode.SUCCESS) {
            throw new Error(`Could not re-establish authentication for WebSocket. (${response})`);
        }
    }

    private async connectWebSocket(): Promise<void> {
        if(this.ws?.readyState === WebSocket.OPEN) {
            return;
        }
        if(this.wsConnectPromise) {
            return await this.wsConnectPromise;
        }

        this.wsConnectPromise = (async () => {
            if(this.ws?.readyState === WebSocket.OPEN) {
                return;
            }
            if(this.ws?.readyState === WebSocket.CONNECTING) {
                await this.waitForWebSocketOpen(this.ws, 10_000);
                return;
            }
            if(this.wsConnecting) {
                // Another connect path is in-flight; let the promise gate handle it.
                return;
            }

            this.wsConnecting = true;
            try {
                // `serve()` is normally called after a successful sign-in, but keep this resilient.
                const response = await this.injector.onResilient(this.client);
                if(response !== ClientResponseCode.SUCCESS) {
                    this.log.warn(`[WebSocket] cannot connect (sign-in failed: ${response}).`);
                    this.scheduleWebSocketReconnect("sign-in failed");
                    throw new Error(`WebSocket sign-in failed (${response}).`);
                }

                const url = this.getWebSocketUrl();
                const headers = this.getWebSocketHeaders();

                // Close any previous instance (best-effort) before replacing.
                try {
                    this.ws?.close();
                } catch {
                    // ignore
                }

                const ws = new WebSocket(url, { headers } as any);
                this.ws = ws;
                this.wsClosedByUser = false;

                ws.on("open", () => {
                    this.wsReconnectAttempt = 0;
                    this.log.info(`[WebSocket] connected: ${url}`);
                });

                ws.on("message", async (data: WebSocket.RawData) => {
                    const text = WebSocketScheduler.wsRawDataToString(data).trim();

                    // Mirror the HTTP retry logic: refresh auth when the server indicates login is required.
                    if(text === "requireLoginForAjax" || /requireLogin/i.test(text)) {
                        this.log.warn("[WebSocket] server requested re-authentication; reconnecting.");
                        try {
                            await this.refreshAuthForWebSocket();
                        } catch (e) {
                            this.log.error(`[WebSocket] re-authentication failed: ${(e as any)?.message || e}`);
                        }
                        try {
                            ws.close();
                        } catch {
                            // ignore
                        }
                        return;
                    }

                    const json = Utils.parseJsonSafe(text);
                    this.log.debug(`[WebSocket] message (JSON): ${JSON.stringify(json)}`);

                    const header = json["header"];
                    for(const info of this.listeners) {
                        if(info.deviceType.toString() === header["type"]) {
                            info.listener(json["data"]);
                        }
                    }
                });

                ws.on("close", (code: number, reason: Buffer) => {
                    const reasonText = reason?.toString("utf8") || "";
                    this.log.warn(`[WebSocket] closed (code=${code}${reasonText ? `, reason=${reasonText}` : ""})`);
                    if(!this.wsClosedByUser) {
                        this.scheduleWebSocketReconnect(`closed:${code}`);
                    }
                });

                ws.on("error", (err: Error) => {
                    this.log.warn(`[WebSocket] error: ${err?.message || err}`);
                });

                ws.on("unexpected-response", async (_req, res) => {
                    const statusCode = (res as any)?.statusCode;
                    this.log.warn(`[WebSocket] unexpected response (status=${statusCode ?? "unknown"}).`);
                    if(statusCode === 401 || statusCode === 403) {
                        try {
                            await this.refreshAuthForWebSocket();
                        } catch (e) {
                            this.log.error(`[WebSocket] re-authentication failed after unexpected response: ${(e as any)?.message || e}`);
                        }
                    }
                });

                await this.waitForWebSocketOpen(ws, 10_000);
            } finally {
                this.wsConnecting = false;
            }
        })().finally(() => {
            this.wsConnectPromise = undefined;
        });

        return await this.wsConnectPromise;
    }

    public async serve() {
        // Keep WebSocket alive in the background. On auth/session expiry, this reconnects after re-sign-in.
        try {
            await this.connectWebSocket();
        } catch (e) {
            this.log.error(`[WebSocket] initial connect failed: ${(e as any)?.message || e}`);
            this.scheduleWebSocketReconnect("initial connect failed");
        }
    }
}