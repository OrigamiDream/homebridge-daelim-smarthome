import readlineSync from 'readline-sync';
import {DaelimConfig} from "./interfaces/daelim-config";
import {Utils} from "./utils";
import {Logging} from "homebridge";
import {ErrorCallback, NetworkHandler, ResponseCallback} from "./network";
import {Errors, LoginSubTypes, SubTypes, Types} from "./fields";

interface ClientAuthorization {
    certification: string,
    login: string
}

interface ClientAddress {
    complex: string,
    room: string
}

export class Client {

    public static MMF_SERVER_PORT = 25301;

    private readonly log: Logging
    private readonly config: DaelimConfig;
    private readonly authorization: ClientAuthorization;
    private readonly address: ClientAddress;
    private complexInfo?: object;
    private handler?: NetworkHandler;
    private isLoggedIn = false;

    constructor(log: Logging, config: DaelimConfig) {
        this.log = log;
        this.config = config;
        this.authorization = {
            certification: '00000000',
            login: ''
        };
        this.address = {
            complex: '',
            room: ''
        };
    }

    private async readComplexInfo(): Promise<object> {
        const { regions } = await Utils.fetchComplexInfo();
        const complexes = regions.filter(region => {
            return region['danjiArea'] === this.config.region && region['name'] === this.config.complex;
        });
        return complexes[0];
    }

    private getAuthorizationPIN(): string {
        let pin: string;
        if(this.authorization.login.length !== 8) {
            pin = this.authorization.certification;
        } else {
            pin = this.authorization.login;
        }
        return pin;
    }

    sendRequest(body: any, type: Types, subType: SubTypes) {
        if(this.handler !== undefined) {
            this.log(`===> ${JSON.stringify(body)}`);
            this.handler.sendRequest(body, this.getAuthorizationPIN(), type, subType);
        }
    }

    sendDeferredRequest(body: any, type: Types, fromSubType: SubTypes, toSubType: SubTypes, matches?: (response: any) => boolean): Promise<any> {
        if(this.handler !== undefined) {
            this.log(`===> ${JSON.stringify(body)}`);
            return this.handler.sendDeferredRequest(body, this.getAuthorizationPIN(), type, fromSubType, toSubType, matches);
        }
        return new Promise<any>((resolve, reject) => reject('Handler not valid'));
    }

    registerResponseListener(type: Types, subType: SubTypes, callback: ResponseCallback) {
        if(this.handler !== undefined) {
            this.handler.registerResponseListener(type, subType, callback);
        }
    }

    registerErrorListener(error: Errors, callback: ErrorCallback) {
        if(this.handler !== undefined) {
            this.handler.registerErrorListener(error, callback);
        }
    }

    registerListeners() {
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_RESPONSE, (body) => {
            this.authorization.certification = body['certpin'];
            this.address.complex = body['dong'];
            this.address.room = body['ho'];

            this.sendRequest({
                id: this.config.username,
                pw: this.config.password,
                certpin: this.authorization.certification
            }, Types.LOGIN, LoginSubTypes.LOGIN_PIN_REQUEST);
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.LOGIN_PIN_RESPONSE, (body) => {
            this.authorization.login = body['loginpin'];
            this.sendRequest({}, Types.LOGIN, LoginSubTypes.MENU_REQUEST);
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.MENU_RESPONSE, (body) => {
            this.isLoggedIn = true;
            if(this.handler?.flushAllEnqueuedBuffers(this.getAuthorizationPIN())) {
                this.log("Flushed entire enqueued request buffers");
            }
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.WALL_PAD_RESPONSE, (body) => {
            this.log('Certified Wall pad PIN');
            this.sendCertificationRequest();
        });
    }

    registerErrorListeners() {
        this.registerErrorListener(Errors.UNCERTIFIED_DEVICE, () => {
            this.sendRequest({
                id: this.config.username,
                pw: this.config.password,
            }, Types.LOGIN, LoginSubTypes.DELETE_CERTIFICATION_REQUEST);
            this.sendRequest({
                id: this.config.username
            }, Types.LOGIN, LoginSubTypes.APPROVAL_DELETE_REQUEST);
            this.sendRequest({
                dong: this.address.complex,
                ho: this.address.room,
                id: this.config.username,
                auth: 2
            }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST);

            const wallPadNumber = readlineSync.question('Enter wall-pad PIN: ');

            this.sendRequest({
                dong: this.address.complex,
                ho: this.address.room,
                id: this.config.username,
                num: String(wallPadNumber)
            }, Types.LOGIN, LoginSubTypes.WALL_PAD_REQUEST);
        });
    }

    sendCertificationRequest() {
        this.sendRequest({
            id: this.config.username,
            pw: this.config.password,
            UUID: this.config.uuid
        }, Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_REQUEST);
    }

    async prepareService() {
        this.log('Looking for complex info...');
        this.complexInfo = await this.readComplexInfo();
        this.log(`Complex info about (${this.config.complex}) has found.`);
        this.handler = new NetworkHandler(this.log, this.config, this.complexInfo);
        this.handler.onConnected = () => {
            this.sendCertificationRequest();
        };
        this.handler.onDisconnected = () => {
            this.isLoggedIn = false;
            this.log("Connection broken. Reconnect to the server...");
            this.handler?.handle();
        };
    }

    startService() {
        if(this.handler === undefined) {
            return;
        }
        this.registerListeners();
        this.registerErrorListeners();

        this.handler.handle();
    }

}