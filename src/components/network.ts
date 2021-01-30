import net from "net";
import {Client} from "./client";
import {Logging} from "homebridge";
import {DaelimConfig} from "./interfaces/daelim-config";
import {Chunk} from "./chunk";
import {Packet} from "./packet";
import {Errors, SubTypes, Types} from "./fields";

export type ResponseCallback = (body: any) => void;
export type ErrorCallback = () => void;

interface ResponseListener {

    type: Types,
    subType: SubTypes,
    callback: ResponseCallback

}

interface ErrorListener {

    error: Errors,
    callback: ErrorCallback

}

interface DeferredRequest {
    resolve: (value?: any | PromiseLike<any>) => void,
    reject: (reason?: any) => void,

    type: Types,
    toSubTypes: SubTypes,
    matches?: (response: any) => boolean

    timestamp: number
}

interface EnqueuedRequest {

    body: any,
    type: Types,
    subType: SubTypes

}

export class NetworkHandler {

    private socket?: net.Socket;
    private readBuffers = new ArrayBuffer(0);
    private isConnected = false;

    private readonly log: Logging;
    private readonly config: DaelimConfig;
    private readonly complexInfo: any;

    private readonly listeners: ResponseListener[] = [];
    private readonly errorListeners: ErrorListener[] = [];

    private readonly deferredRequests: DeferredRequest[] = [];
    private readonly enqueuedRequests: EnqueuedRequest[] = [];

    public onConnected?: () => void;
    public onDisconnected?: () => void;

    constructor(log: Logging, config: DaelimConfig, complexInfo: any) {
        this.log = log;
        this.config = config;
        this.complexInfo = complexInfo;
    }

    registerResponseListener(type: Types, subType: SubTypes, callback: ResponseCallback) {
        this.listeners.push({
            type: type,
            subType: subType,
            callback: callback
        });
    }

    registerErrorListener(error: Errors, callback: ErrorCallback) {
        this.errorListeners.push({
            error: error,
            callback: callback
        });
    }

    sendRequest(body: object, pin: string, type: Types, subType: SubTypes) {
        if(!this.isConnected) {
            this.enqueuedRequests.push({
                body: body,
                type: type,
                subType: subType
            });
            this.log("Connection broken. Reconnect to the server...");
            this.handle();
            return;
        }
        this.socket?.write(Buffer.from(Packet.create(body, pin, type, subType, 1, 3).getBytes()));
    }

    flushAllEnqueuedBuffers(pin: string): boolean {
        if(!this.isConnected || this.enqueuedRequests.length === 0) {
            return false;
        }
        while(this.enqueuedRequests.length > 0) {
            const requests = this.enqueuedRequests.splice(0, 1);
            for(const request of requests) {
                this.sendRequest(request.body, pin, request.type, request.subType)
            }
        }
        return true;
    }

    sendDeferredRequest(body: any, pin: string, type: Types, fromSubType: SubTypes, toSubType: SubTypes, matches?: (response: any) => boolean): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.sendRequest(body, pin, type, fromSubType);
            this.deferredRequests.push({
                resolve: resolve,
                reject: reject,
                type: type,
                toSubTypes: toSubType,
                matches: matches,
                timestamp: Date.now(),
            });
        });
    }

    handle() {
        if(this.socket) {
            this.socket.end();
            this.socket = undefined;
        }
        this.socket = net.connect({
            host: this.complexInfo["ip"],
            port: Client.MMF_SERVER_PORT
        });
        this.socket.on('connect', () => {
            this.isConnected = true;
            this.log('Connected to server');

            if(this.onConnected !== undefined) {
                this.onConnected();
            }
        });
        this.socket.on('data', (data) => {
            this.appendBuffer(data);
            do {
            } while(this.handleResponse());
        });
        this.socket.on('end', () => {
            if(this.onDisconnected !== undefined) {
                this.onDisconnected();
            }
            this.isConnected = false;
            this.socket = undefined;
            this.log('Disconnected from MMF server');
        });
        this.socket.on('error', (error) => {
            if(this.onDisconnected !== undefined) {
                this.onDisconnected();
            }
            this.isConnected = false;
            this.socket = undefined;
            this.log.error(error.message);
        });
        this.socket.on('timeout', () => {
            if(this.onDisconnected !== undefined) {
                this.onDisconnected();
            }
            this.isConnected = false;
            this.socket = undefined;
            this.log.error('Connection timed out');
        });
    }

    private appendBuffer(bytes: Uint8Array | Buffer, offset = 0, length = bytes.byteLength) {
        const temp = new Uint8Array(this.readBuffers.byteLength + length);
        temp.set(new Uint8Array(this.readBuffers), 0);
        temp.set(new Uint8Array(bytes.slice(offset, length + offset)), this.readBuffers.byteLength);
        this.readBuffers = temp.buffer;
    }

    private handleResponse(): boolean {
        const rawData = new Uint8Array(this.readBuffers);
        const chunk = Chunk.parse(rawData);
        if(chunk === undefined) {
            return false;
        }
        const packet = Packet.parse(rawData);
        this.readBuffers = new ArrayBuffer(0);
        const chunkSize = chunk.getSize();
        if(rawData.byteLength > chunkSize) {
            this.appendBuffer(rawData, chunkSize, rawData.byteLength - chunkSize);
        }
        this.log(`<=== ${JSON.stringify(packet?.getJSONBody())}`);
        if(packet !== undefined) {
            const header = packet.getHeader();
            if(header.getError() === Errors.SUCCESS) {
                if(this.deferredRequests.length > 0) {
                    let index = 0;
                    while(index < this.deferredRequests.length) {
                        const request = this.deferredRequests[index];
                        if(Date.now() - request.timestamp > 1000 * 10) {
                            // 10 seconds timeout
                            request.reject('Deferred request time out.');
                            this.deferredRequests.splice(index, 1);
                            continue;
                        }

                        const response = packet.getJSONBody();
                        if(request.type === header.getType() && request.toSubTypes === header.getSubType() && (!request.matches || request.matches(response))) {
                            request.resolve(response);
                            this.deferredRequests.splice(index, 1);
                            continue;
                        }
                        index++;
                    }
                }
                for(const listener of this.listeners) {
                    if(listener.type === header.getType() && listener.subType == header.getSubType()) {
                        listener.callback(packet.getJSONBody());
                    }
                }
            } else {
                for(const listener of this.errorListeners) {
                    if(listener.error === header.getError()) {
                        listener.callback();
                    }
                }
            }
        }
        return true;
    }

}