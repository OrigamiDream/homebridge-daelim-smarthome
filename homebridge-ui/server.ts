import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {ErrorCallback, LoggerBase, NetworkHandler, ResponseCallback} from "../core/network";
import {Utils} from "../core/utils";
import {Errors, LoginSubTypes, SubTypes, Types} from "../core/fields";
import * as crypto from 'crypto';

interface ClientAuthorization {
    certification: string,
    login: string
}

interface ClientAddress {
    complex: string,
    room: string
}

class Logger implements LoggerBase {

    debug(message: string, ...parameters: any[]): void {
        console.debug(message, ...parameters);
    }

    error(message: string, ...parameters: any[]): void {
        console.error(message, ...parameters);
    }

    info(message: string, ...parameters: any[]): void {
        console.info(message, ...parameters);
    }

    warn(message: string, ...parameters: any[]): void {
        console.warn(message, ...parameters);
    }

}

export class UiServer extends HomebridgePluginUiServer {

    private readonly log: Logger

    private region?: string = undefined;
    private complex?: string = undefined;
    private username?: string = undefined;
    private password?: string = undefined;
    private uuid?: string = undefined;

    private handler?: NetworkHandler = undefined;
    private isLoggedIn: boolean = false;
    private readonly authorization: ClientAuthorization;
    private readonly address: ClientAddress;

    constructor() {
        super();

        // @ts-ignore
        this.log = new Logger();

        this.authorization = {
            certification: '00000000',
            login: ''
        };
        this.address = {
            complex: '',
            room: ''
        };

        this.onRequest('/choose-region', this.chooseRegion.bind(this));
        this.onRequest('/choose-complex', this.chooseComplex.bind(this));
        this.onRequest('/sign-in', this.handleSignIn.bind(this));
        this.onRequest('/passcode', this.handleWallPadPasscode.bind(this));
        this.onRequest('/invalidate', this.invalidate.bind(this));

        this.ready();
    }

    invalidateAuthorizations() {
        this.authorization.certification = '00000000';
        this.authorization.login = '';
        this.address.complex = '';
        this.address.room = '';
    }

    async invalidate(_: any) {
        this.invalidateAuthorizations();
        this.region = undefined;
        this.complex = undefined;
        this.username = undefined;
        this.password = undefined;
        this.uuid = undefined;
    }

    async chooseRegion(payload: any): Promise<any> {
        const region = payload.region;
        if(region === undefined) {
            return {
                result: false
            };
        }
        this.region = region;
        this.log.info('Region:', this.region);
        return {
            result: true
        };
    }

    async chooseComplex(payload: any) {
        const complex = payload.complex;
        if(complex === undefined) {
            return {
                result: false
            };
        }
        this.complex = complex;
        this.log.info('Complex:', this.complex);
        return {
            result: true
        };
    }

    async handleSignIn(payload: any) {
        const username = payload.username;
        const password = payload.password;
        this.log.info('Username:', username);
        this.log.info('Region:', this.region);
        this.log.info('Complex:', this.complex);

        this.username = username;
        this.password = password;
        this.uuid = UiServer.generateUUID(username);

        if(this.region && this.complex) {
            this.log.info('Starting service...');
            await this.createService();
        }
    }

    async handleWallPadPasscode(payload: any) {
        const wallPadNumber = payload.wallpad;

        this.sendUnreliableRequest({
            dong: this.address.complex,
            ho: this.address.room,
            id: this.username,
            num: String(wallPadNumber)
        }, Types.LOGIN, LoginSubTypes.WALL_PAD_REQUEST);
    }

    private static generateUUID(key: string): string {
        return crypto
            .createHash('md5')
            .update(key)
            .digest('hex')
            .toUpperCase();
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

    sendUnreliableRequest(body: any, type: Types, subType: SubTypes) {
        if(this.handler !== undefined) {
            this.handler.sendUnreliableRequest(body, this.getAuthorizationPIN(), type, subType);
        }
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

    sendCertificationRequest() {
        this.sendUnreliableRequest({
            id: this.username,
            pw: this.password,
            UUID: this.uuid,
        }, Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_REQUEST);
    }

    async createService() {
        const {regions} = await Utils.fetchComplexInfo();
        const complexes = regions.filter(region => {
            return region['danjiArea'] === this.region && region['name'] === this.complex;
        });
        const complexInfo = complexes[0];
        this.handler = new NetworkHandler(this.log, complexInfo);
        this.handler.onConnected = () => {
            if(!this.username || !this.password) {
                this.log.error("Username and password is not valid");
            }
            this.sendCertificationRequest();
        };
        this.handler.onDisconnected = () => {
            this.log.info('Connection broken.');
        };

        // Start the service
        this.handler.handle();

        // Event Listeners
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.CERTIFICATION_PIN_RESPONSE, (body) => {
            this.authorization.certification = body['certpin'];
            this.address.complex = body['dong'];
            this.address.room = body['ho'];

            this.sendUnreliableRequest({
                id: this.username,
                pw: this.password,
                certpin: this.authorization.certification
            }, Types.LOGIN, LoginSubTypes.LOGIN_PIN_REQUEST);
        });
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.LOGIN_PIN_RESPONSE, async (body) => {
            this.authorization.login = body['loginpin'];
            this.isLoggedIn = true;

            // On complete
            this.pushEvent('complete', { uuid: this.uuid });

            if(this.handler) {
                this.handler.disconnect();
                this.handler = undefined;
            }
            await this.invalidate(null);
        })
        this.registerResponseListener(Types.LOGIN, LoginSubTypes.WALL_PAD_RESPONSE, async (_) => {
            this.sendCertificationRequest();
        });
        // Error Listeners
        this.registerErrorListener(Errors.UNCERTIFIED_DEVICE, () => {
            this.sendUnreliableRequest({
                id: this.username,
                pw: this.password
            }, Types.LOGIN, LoginSubTypes.DELETE_CERTIFICATION_REQUEST);
            this.sendUnreliableRequest({
                id: this.username
            }, Types.LOGIN, LoginSubTypes.APPROVAL_DELETE_REQUEST);
            this.sendUnreliableRequest({
                dong: this.address.complex,
                ho: this.address.room,
                id: this.username,
                auth: 2
            }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST);

            this.pushEvent('require-wall-pad-number', {});
        });
        this.registerErrorListener(Errors.INVALID_CERTIFICATION_NUMBER, () => {
            this.pushEvent('invalid-wall-pad-number', {});
        });
        this.registerErrorListener(Errors.INVALID_USERNAME_AND_PASSWORD, () => {
            this.pushEvent('invalid-authorization', {
                reason: 'invalid_username_and_password'
            });
        });
        this.registerErrorListener(Errors.REGISTRATION_NOT_COMPLETED, () => {
            this.sendUnreliableRequest({
                dong: this.address.complex,
                ho: this.address.room,
                id: this.username,
                auth: 2
            }, Types.LOGIN, LoginSubTypes.APPROVAL_REQUEST);

            this.pushEvent('require-wall-pad-number', {});
        });
    }
}

(() => {
    return new UiServer;
})();