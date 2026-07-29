import {Device, DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue,
    Logging,
    PlatformAccessory, Service
} from "homebridge";
import {DeviceWithOp} from "./accessories";
import ActiveAccessories, {ActiveAccessoryInterface} from "./active-accessories";
import {VentMode} from "../../../core/smart-elife/parsers/vent-mode-parsers";

enum RotationSpeed {
    OFF = "off",
    LOW = "low",
    MIDDLE = "middle",
    HIGH = "high",
}

enum Mode {
    AUTO_DRIVING = "auto",
    BYPASS = "bypass",
    MANUAL = "manual",
}

const ROTATION_SPEED_STEP = 100 / 3.0;
const VENT_OPERATION_TIMEOUT_MILLISECONDS = 3_000;

/**
 * How quiet the characteristic writes have to go before the gesture counts as finished.
 *
 * One gesture reaches the accessory as several writes. Turning a mode switch on also
 * writes `TargetAirPurifierState`, because every mode but automatic reads as MANUAL
 * there, and an automation that carries a speed adds a third. Acting on each as it
 * arrives sends them in whatever order they land in, and the device resets `wind_speed`
 * whenever the mode changes, so a speed that went out ahead of the mode is wiped by it.
 * Gathering the writes first also settles their disagreements: MANUAL only says "not
 * automatic", so it must not overrule the switch that named a mode.
 *
 * Two hundred milliseconds is what the light accessory measured against this WallPad,
 * which answers a command in 115..217ms; it gathers a gesture without adding a delay
 * worth noticing next to the round trip that follows.
 */
const COMMAND_WINDOW_MILLISECONDS = 200;

// The device type as users know it. The server calls the device 환기, which is fine for
// the accessory itself but too vague once the modes hang off it as separate tiles.
const MODE_SWITCH_PREFIX = "전열교환기";
// The plain ventilation mode is labelled 환기 by the server, which reads as the device
// rather than as one mode among several once it sits next to 공기청정 and 바이패스.
const PLAIN_VENTILATION_LABEL = "환기";
const PLAIN_VENTILATION_DISPLAY_LABEL = "일반환기";
// The label the server uses for automatic driving. `TargetAirPurifierState` already
// represents that mode, so it never becomes a switch, and matching the label as well as
// the value keeps a household that renamed it from growing a duplicate control.
const AUTO_DRIVING_LABEL = "자동";

interface VentAccessoryInterface extends ActiveAccessoryInterface {
    rotationSpeed: RotationSpeed
    /**
     * Speed to return to once a mode that supports one is selected again. Automatic
     * driving and bypass report no `wind_speed` at all, so without this the selection
     * is lost every time the vent passes through them.
     */
    lastRotationSpeed?: RotationSpeed
    mode: string
}

interface PendingVentConfirmation {
    operation: Record<string, any>
    complete: (confirmed: boolean) => void
}

/**
 * The writes of one gesture, and the state it started from. What the device is asked for
 * is decided once the writes stop, against the state at the start rather than against a
 * state the gesture's own earlier commands have already moved.
 */
interface PendingGesture {
    timer: NodeJS.Timeout
    baseActive: boolean
    baseMode: string
    active?: boolean
    /** A mode the user named, through a mode switch or by asking for automatic. */
    namedMode?: string
    /** `TargetAirPurifierState` went to MANUAL, which names no mode of its own. */
    manualRequested?: boolean
    rotationSpeed?: RotationSpeed
}

export default class VentAccessories extends ActiveAccessories<VentAccessoryInterface> {
    private readonly deviceOperationQueues = new Map<string, Promise<void>>();
    private readonly pendingConfirmations = new Map<string, PendingVentConfirmation>();
    // Mode switches whose SET/GET handlers are already attached, per device. Services
    // restored from the accessory cache come back without their handlers, and the sync
    // runs on every device event, so both cases have to be told apart.
    private readonly configuredModeSwitches = new Map<string, Set<string>>();
    private readonly gestures = new Map<string, PendingGesture>();
    /**
     * Devices whose gathered gesture is being carried out right now.
     *
     * A gesture leaves as several commands, and the device reports the state after each
     * one, so a run that ends at high is reported at low first and only then at high.
     * Every one of those reports is true, and reflecting them as they arrive is what
     * makes the slider visibly jump before it settles. Held back until the last command
     * is answered, the accessory shows the result of the gesture rather than the route
     * it took.
     *
     * This is deliberately not the light accessory's echo window. That one distrusts
     * reports for a fixed two seconds because a thirty-second poll can return a page
     * older than the command and leave a wrong state standing until the next poll. The
     * vent has no such gap to cover: it pushes a report about every second, so a stale
     * one is corrected almost at once, and each command here is confirmed against a
     * device event before the next is sent. What is held back is only what arrives while
     * this accessory's own commands are in flight, and only until they finish, so a
     * change made at the WallPad during that second is applied as soon as they do rather
     * than being discarded the way a fixed window would discard it.
     */
    private readonly runningGestures = new Set<string>();
    private operationTimeoutMilliseconds = VENT_OPERATION_TIMEOUT_MILLISECONDS;
    private commandWindowMilliseconds = COMMAND_WINDOW_MILLISECONDS;

    protected handlesActive(): boolean {
        // Power belongs to the gesture like everything else: a switch pressed while the
        // vent is off carries the power-on with it, and the base class sending its own
        // would put a command ahead of the mode.
        return true;
    }

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.VENT,
            [api.hap.Service.AirPurifier, api.hap.Service.AirQualitySensor, api.hap.Service.Switch],
            api.hap.Service.AirPurifier);
    }

    private homebridgeToRotationSpeed(value: number): RotationSpeed {
        if(value <= 0) return RotationSpeed.OFF;
        if(value <= ROTATION_SPEED_STEP) return RotationSpeed.LOW;
        if(value <= ROTATION_SPEED_STEP * 2) return RotationSpeed.MIDDLE;
        return RotationSpeed.HIGH;
    }

    private rotationSpeedToHomebridge(rotationSpeed: RotationSpeed): number {
        switch (rotationSpeed) {
            case RotationSpeed.LOW: return ROTATION_SPEED_STEP;
            case RotationSpeed.MIDDLE: return ROTATION_SPEED_STEP * 2;
            case RotationSpeed.HIGH: return 100;
            default: return 0;
        }
    }

    /**
     * What the slider reads. A mode without wind control parks it at full rather than at
     * zero: the vent is running, it is only the choice of speed that is unavailable, and
     * a zero would read as stopped. This matches how the air conditioner presents
     * wallpad-managed wind since #179.
     */
    private homebridgeRotationSpeed(context: VentAccessoryInterface): number {
        if(!context.active) return 0;
        if(!this.isFanSpeedControllableMode(context.mode)) return 100;
        return this.rotationSpeedToHomebridge(context.rotationSpeed);
    }

    private isHomeKitAutomaticMode(mode: string | undefined): boolean {
        // An allowlist: every other mode is a deliberate selection the user made, and
        // reporting those as AUTO is what hid bypass and cleaning from HomeKit before.
        return mode === Mode.AUTO_DRIVING;
    }

    private isFanSpeedControllableMode(mode: string | undefined): boolean {
        // The native UI disables wind speed for automatic driving and bypass, and those
        // are also the two modes the device reports with no `wind_speed` field at all.
        // Modes we have not seen keep their low/middle/high control.
        return !!mode && mode !== Mode.AUTO_DRIVING && mode !== Mode.BYPASS;
    }

    private deviceMode(value: unknown, fallback: string = Mode.AUTO_DRIVING): string {
        // Preserve app-controlled modes that HomeKit cannot represent. Every non-manual
        // mode is exposed as HomeKit AUTO without discarding its native behavior.
        return typeof value === "string" && value.length > 0
            ? value
            : fallback;
    }

    private deviceRotationSpeed(value: unknown): RotationSpeed {
        switch(value) {
            case RotationSpeed.LOW:
            case RotationSpeed.MIDDLE:
            case RotationSpeed.HIGH:
                return value;
            default:
                return RotationSpeed.OFF;
        }
    }

    // ---- mode switches -------------------------------------------------------

    /** The modes that become switches: everything the vent supports except automatic. */
    private switchableModes(deviceId: string): VentMode[] | undefined {
        // `_client` rather than `client`, which throws before the provider has served.
        const modes = this._client?.getVentModes(deviceId);
        if(!modes) {
            return undefined;
        }
        return modes.filter((mode) => !this.isAutoDrivingMode(mode));
    }

    private modeSwitchHandlerRegistry(deviceId: string): Set<string> {
        let configured = this.configuredModeSwitches.get(deviceId);
        if(!configured) {
            configured = new Set<string>();
            this.configuredModeSwitches.set(deviceId, configured);
        }
        return configured;
    }

    /** Every mode switch the accessory carries, whatever the device reports today. */
    private modeSwitchServices(accessory: PlatformAccessory): Service[] {
        return accessory.services.filter((service) =>
            service.UUID === this.api.hap.Service.Switch.UUID && !!service.subtype);
    }

    private isAutoDrivingMode(mode: VentMode): boolean {
        return mode.value === Mode.AUTO_DRIVING || mode.label === AUTO_DRIVING_LABEL;
    }

    private modeSwitchName(mode: VentMode): string {
        const label = mode.label === PLAIN_VENTILATION_LABEL
            ? PLAIN_VENTILATION_DISPLAY_LABEL
            : (mode.label || mode.value);
        return `${MODE_SWITCH_PREFIX} ${label} 모드`;
    }

    /**
     * Brings the mode switches in line with what the vent supports, attaching handlers
     * to services that were just created or restored from the accessory cache. Does
     * nothing at all while the supported modes are unknown: an unreadable control page
     * must not be mistaken for a vent that lost its modes.
     */
    private syncModeSwitches(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const modes = this.switchableModes(context.deviceId);
        if(!modes) {
            return;
        }
        const configured = this.modeSwitchHandlerRegistry(context.deviceId);
        for(const mode of modes) {
            const service = accessory.getServiceById(this.api.hap.Service.Switch, mode.value)
                || accessory.addService(this.api.hap.Service.Switch, this.modeSwitchName(mode), mode.value);
            // The Home app labels a service by `ConfiguredName` and falls back to the
            // accessory name for every one of them without it. It is only ever written
            // once: the characteristic is writable, so a later write would undo a rename
            // the user made in the Home app.
            if(!service.testCharacteristic(this.api.hap.Characteristic.ConfiguredName)) {
                service.addOptionalCharacteristic(this.api.hap.Characteristic.ConfiguredName);
                service.setCharacteristic(this.api.hap.Characteristic.ConfiguredName, this.modeSwitchName(mode));
            }
            this.configureModeSwitch(accessory, service, mode.value, configured);
        }

        // Drop switches for modes this vent no longer offers. Only reachable once the
        // modes were read successfully, so a failed read never removes anything.
        const supported = new Set(modes.map((mode) => mode.value));
        const stale = this.modeSwitchServices(accessory)
            .filter((service) => !supported.has(service.subtype!));
        for(const service of stale) {
            this.log.info("Removing the mode switch %s from %s: the device no longer offers it.",
                service.subtype, context.displayName);
            configured.delete(service.subtype!);
            accessory.removeService(service);
        }
    }

    private configureModeSwitch(accessory: PlatformAccessory, service: Service, mode: string, configured: Set<string>) {
        if(configured.has(mode)) {
            return;
        }
        configured.add(mode);
        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                this.recordGesture(accessory, (gesture) => {
                    if(value) {
                        // Naming a mode also starts the vent: the switch is meaningless
                        // on a vent that is off, and the app starts it the same way.
                        gesture.namedMode = mode;
                        gesture.active = true;
                        return;
                    }
                    if(gesture.namedMode === mode) {
                        // Cleared again inside the same gesture.
                        gesture.namedMode = undefined;
                        return;
                    }
                    // There is no "no mode" state to fall back to, so clearing the mode
                    // the vent is running stops it. Clearing any other switch is already
                    // true and asks for nothing.
                    if(this.isModeSwitchOn(this.getAccessoryInterface(accessory), mode)) {
                        gesture.active = false;
                    }
                });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.isModeSwitchOn(this.getAccessoryInterface(accessory), mode));
            });
    }

    private isModeSwitchOn(context: VentAccessoryInterface, mode: string): boolean {
        return context.active && context.mode === mode;
    }

    // ---- gestures ------------------------------------------------------------

    /**
     * Records one characteristic write and restarts the quiet period. The gesture is
     * carried out by `flushGesture()` once the writes stop.
     */
    private recordGesture(accessory: PlatformAccessory, apply: (gesture: PendingGesture) => void) {
        const context = this.getAccessoryInterface(accessory);
        let gesture = this.gestures.get(context.deviceId);
        if(!gesture) {
            gesture = {
                timer: undefined as unknown as NodeJS.Timeout,
                baseActive: context.active,
                baseMode: context.mode,
            };
            this.gestures.set(context.deviceId, gesture);
        } else {
            clearTimeout(gesture.timer);
        }
        apply(gesture);
        gesture.timer = setTimeout(() => {
            void this.flushGesture(accessory);
        }, this.commandWindowMilliseconds);
        gesture.timer.unref();
    }

    /**
     * Turns the gathered writes into commands, in the order the device needs them:
     * power first, because nothing else applies while it is off, then the mode, and the
     * speed last because a mode change resets it.
     */
    private async flushGesture(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const gesture = this.gestures.get(context.deviceId);
        if(!gesture) {
            return;
        }
        clearTimeout(gesture.timer);
        this.gestures.delete(context.deviceId);
        // Reflection stays off from the first write of the gesture right through to the
        // last command it produces. Dropping it here, between the two, would let the
        // states the device passes through on the way reach the characteristics.
        this.runningGestures.add(context.deviceId);

        const device = this.findDevice(context.deviceId);
        if(!device) {
            this.log.warn("Unknown device: %s", context.deviceId);
            this.runningGestures.delete(context.deviceId);
            this.applyAccessoryState(accessory);
            return;
        }

        // A named mode wins over MANUAL, which only says the vent is not on automatic
        // and would otherwise undo the switch that was pressed in the same gesture.
        const wantedMode = gesture.namedMode
            || (gesture.manualRequested ? Mode.MANUAL : undefined);
        const wantedActive = gesture.active !== undefined
            ? gesture.active
            : (gesture.baseActive || wantedMode !== undefined || gesture.rotationSpeed !== undefined);

        try {
            await this.enqueueDeviceOperation(device.deviceId, async () => {
                if(!wantedActive) {
                    if(this.getAccessoryInterface(accessory).active) {
                        await this.sendDeviceStateAndWait({...device, op: {control: "off"}});
                    }
                    return true;
                }
                if(!this.getAccessoryInterface(accessory).active) {
                    const turnedOn = await this.sendDeviceStateAndWait({
                        ...device,
                        op: this.onSetActivityOp(true, {control: "on"}),
                    });
                    if(!turnedOn) return false;
                }
                if(wantedMode && this.getAccessoryInterface(accessory).mode !== wantedMode) {
                    const changed = await this.sendDeviceStateAndWait({...device, op: {mode: wantedMode}});
                    if(!changed) return false;
                }
                const current = this.getAccessoryInterface(accessory);
                if(gesture.rotationSpeed && gesture.rotationSpeed !== RotationSpeed.OFF
                    && this.isFanSpeedControllableMode(current.mode)
                    && current.rotationSpeed !== gesture.rotationSpeed) {
                    await this.sendDeviceStateAndWait({
                        ...device,
                        op: {wind_speed: gesture.rotationSpeed.toString()},
                    });
                }
                return true;
            });
        } catch(error: any) {
            this.log.warn("Vent control request failed: %s", error?.message || error);
        } finally {
            // Released before the state is put back, and in a `finally` so a command
            // that threw cannot leave the accessory frozen on a state it has left.
            this.runningGestures.delete(context.deviceId);
        }
        // Whatever the device settled on goes back onto the characteristics, which is
        // also what restores a slider the user moved in a mode that has no speed.
        this.applyAccessoryState(accessory);
    }

    // ---- state reflection ----------------------------------------------------

    /**
     * The single place where device state reaches HomeKit. Every characteristic is
     * written with `updateCharacteristic`, which does not run the SET handlers, so
     * reflecting a state can never bounce a command back at the wallpad.
     */
    private applyAccessoryState(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        // While a gesture is being gathered or carried out, the context still follows
        // the device - only the characteristics wait. The report that arrives about
        // every second would otherwise pull the slider out from under a finger, and the
        // states passed through mid-gesture would show as a flicker before the result.
        if(this.gestures.has(context.deviceId) || this.runningGestures.has(context.deviceId)) {
            return;
        }
        const service = this.getService(accessory, this.api.hap.Service.AirPurifier);
        service.updateCharacteristic(this.api.hap.Characteristic.Active, context.active
            ? this.api.hap.Characteristic.Active.ACTIVE
            : this.api.hap.Characteristic.Active.INACTIVE);
        service.updateCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, context.active
            ? this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
            : this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE);
        service.updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState,
            this.isHomeKitAutomaticMode(context.mode)
                ? this.api.hap.Characteristic.TargetAirPurifierState.AUTO
                : this.api.hap.Characteristic.TargetAirPurifierState.MANUAL);
        service.updateCharacteristic(this.api.hap.Characteristic.RotationSpeed,
            this.homebridgeRotationSpeed(context));

        for(const modeSwitch of this.modeSwitchServices(accessory)) {
            modeSwitch.updateCharacteristic(this.api.hap.Characteristic.On,
                this.isModeSwitchOn(context, modeSwitch.subtype!));
        }
    }

    private operationMatchesContext(deviceId: string, operation: Record<string, any>): boolean {
        const accessory = this.findAccessory(deviceId);
        if(!accessory) return false;

        const context = this.getAccessoryInterface(accessory);
        let compared = false;
        if(typeof operation["control"] === "string") {
            compared = true;
            if(context.active !== (operation["control"] === "on")) return false;
        }
        if(typeof operation["mode"] === "string") {
            compared = true;
            if(context.mode !== operation["mode"]) return false;
        }
        if(typeof operation["wind_speed"] === "string") {
            compared = true;
            if(!context.active || !this.isFanSpeedControllableMode(context.mode)
                || context.rotationSpeed !== operation["wind_speed"]) return false;
        }
        return compared;
    }

    private operationMatchesDeviceState(operation: Record<string, any>, state: Record<string, any>): boolean {
        let compared = false;
        if(typeof operation["control"] === "string") {
            compared = true;
            if(state["status"] !== operation["control"]) return false;
        }
        if(typeof operation["mode"] === "string") {
            compared = true;
            if(state["mode"] !== operation["mode"]) return false;
        }
        if(typeof operation["wind_speed"] === "string") {
            compared = true;
            if(state["wind_speed"] !== operation["wind_speed"]) return false;
        }
        return compared;
    }

    private createDeviceConfirmation(deviceId: string, operation: Record<string, any>) {
        let complete: (confirmed: boolean) => void = () => undefined;
        const promise = new Promise<boolean>((resolve) => {
            let completed = false;
            const timer = setTimeout(() => {
                if(completed) return;
                completed = true;
                this.pendingConfirmations.delete(deviceId);
                this.log.warn("Vent operation was not confirmed by a device event: %s", JSON.stringify(operation));
                resolve(false);
            }, this.operationTimeoutMilliseconds);
            timer.unref();

            complete = (confirmed: boolean) => {
                if(completed) return;
                completed = true;
                clearTimeout(timer);
                this.pendingConfirmations.delete(deviceId);
                resolve(confirmed);
            };
        });

        this.pendingConfirmations.set(deviceId, {operation, complete});
        return {promise, cancel: () => complete(false)};
    }

    private confirmDeviceOperation(device: DeviceWithOp) {
        const pending = this.pendingConfirmations.get(device.deviceId);
        if(pending && this.operationMatchesDeviceState(pending.operation, device.op)) {
            pending.complete(true);
        }
    }

    private async sendDeviceStateAndWait(device: DeviceWithOp): Promise<boolean> {
        if(this.operationMatchesContext(device.deviceId, device.op)) return true;

        // Install the waiter before the HTTP request so a fast websocket event cannot
        // arrive between request acceptance and confirmation registration.
        const confirmation = this.createDeviceConfirmation(device.deviceId, device.op);
        try {
            const accepted = await super.setDeviceState(device);
            if(!accepted) {
                confirmation.cancel();
                return false;
            }
            return await confirmation.promise;
        } catch(error) {
            confirmation.cancel();
            throw error;
        }
    }

    private async enqueueDeviceOperation(deviceId: string, operation: () => Promise<boolean>): Promise<boolean> {
        const previous = this.deviceOperationQueues.get(deviceId) || Promise.resolve();
        const queued = previous.then(operation, operation);
        const tail = queued.then(() => undefined, () => undefined);
        this.deviceOperationQueues.set(deviceId, tail);
        try {
            return await queued;
        } finally {
            if(this.deviceOperationQueues.get(deviceId) === tail) {
                this.deviceOperationQueues.delete(deviceId);
            }
        }
    }

    async setDeviceState(device: DeviceWithOp): Promise<boolean> {
        try {
            return await this.enqueueDeviceOperation(device.deviceId, async () => await this.sendDeviceStateAndWait(device));
        } catch(error: any) {
            this.log.warn("Vent control request failed: %s", error?.message || error);
            return false;
        }
    }

    onSetActivityOp(value: boolean, op: Record<string, any>): any {
        if(value)
            op["off_rsv_time"] = "0";
        return op;
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        const purifier = this.getService(accessory, this.api.hap.Service.AirPurifier);
        // Makes the vent itself the accessory's main control, so the mode switches read
        // as belonging to it when the Home app groups them into one tile. They are
        // deliberately not linked services: linking costs them their names.
        purifier.setPrimaryService(true);
        if(!purifier.testCharacteristic(this.api.hap.Characteristic.ConfiguredName)) {
            purifier.addOptionalCharacteristic(this.api.hap.Characteristic.ConfiguredName);
            purifier.setCharacteristic(this.api.hap.Characteristic.ConfiguredName,
                this.getAccessoryInterface(accessory).displayName);
        }

        purifier.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                this.recordGesture(accessory, (gesture) => {
                    gesture.active = active;
                });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });
        purifier.getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                this.recordGesture(accessory, (gesture) => {
                    if(value === this.api.hap.Characteristic.TargetAirPurifierState.AUTO) {
                        gesture.namedMode = Mode.AUTO_DRIVING;
                        gesture.manualRequested = false;
                        return;
                    }
                    // MANUAL names no mode. It only rules automatic out, so it settles on
                    // plain ventilation unless a switch in the same gesture named one.
                    gesture.manualRequested = true;
                    if(gesture.namedMode === Mode.AUTO_DRIVING) {
                        gesture.namedMode = undefined;
                    }
                });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.isHomeKitAutomaticMode(context.mode)
                    ? this.api.hap.Characteristic.TargetAirPurifierState.AUTO
                    : this.api.hap.Characteristic.TargetAirPurifierState.MANUAL);
            });
        purifier.getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.active
                    ? this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
                    : this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE);
            });
        purifier.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const numeric = value as number;
                const newSpeed = this.homebridgeToRotationSpeed(numeric);
                this.log.debug(`Vent :: SET :: RotationSpeed: ${numeric.toFixed(2)} (HomeKit) -> ${newSpeed.toString()}`);
                this.recordGesture(accessory, (gesture) => {
                    if(newSpeed === RotationSpeed.OFF) {
                        // Zero is HomeKit's way of stopping a fan, not a speed. It stops
                        // the vent even where a speed cannot be chosen, which is how the
                        // slider behaves on the air conditioner too.
                        gesture.active = false;
                        gesture.rotationSpeed = undefined;
                        return;
                    }
                    gesture.rotationSpeed = newSpeed;
                    if(gesture.active === false) {
                        // A drag that crossed zero on its way is not a request to stop.
                        gesture.active = undefined;
                    }
                });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.homebridgeRotationSpeed(this.getAccessoryInterface(accessory)));
            });

        // Switches restored from the accessory cache are live in HomeKit from the moment
        // the bridge publishes, which is before the supported modes have been read. Their
        // subtype is the mode, so they can be wired up without that list and never sit
        // there accepting writes that go nowhere.
        const configured = this.modeSwitchHandlerRegistry(this.getAccessoryInterface(accessory).deviceId);
        for(const service of this.modeSwitchServices(accessory)) {
            this.configureModeSwitch(accessory, service, service.subtype!, configured);
        }
        this.syncModeSwitches(accessory);
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const cachedAccessory = this.findAccessory(device.deviceId);
                const cachedContext = cachedAccessory
                    ? this.getAccessoryInterface(cachedAccessory)
                    : undefined;
                const active = device.op["status"] === "on"
                    ? true
                    : device.op["status"] === "off"
                        ? false
                        : cachedContext?.active || false;
                const mode = this.deviceMode(device.op["mode"], cachedContext?.mode);
                const reported = this.deviceRotationSpeed(device.op["wind_speed"]);
                // Modes without wind control omit the field entirely, so the last speed
                // the device did report is what a mode that has one returns to.
                const lastRotationSpeed = reported !== RotationSpeed.OFF
                    ? reported
                    : cachedContext?.lastRotationSpeed;
                const rotationSpeed = active && this.isFanSpeedControllableMode(mode)
                    ? (reported !== RotationSpeed.OFF
                        ? reported
                        : (lastRotationSpeed || RotationSpeed.OFF))
                    : RotationSpeed.OFF;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    rotationSpeed,
                    lastRotationSpeed,
                    mode,
                });
                if(!accessory) {
                    this.confirmDeviceOperation(device);
                    continue;
                }

                this.syncModeSwitches(accessory);
                this.applyAccessoryState(accessory);
                this.confirmDeviceOperation(device);
            }
        });
    }
}
