import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory, Service
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Accessories, {AccessoryInterface} from "./accessories";
import {getGlobalIndoorRelativeHumidity} from "./indoor-air-quality-cache";

interface AirConditionerInterface extends AccessoryInterface {
    active: boolean
    mode: Mode
    rotationSpeed: RotationSpeed

    /**
     * Last manual wind speed (LOW/MIDDLE/HIGH only).
     * Preserved across auto/off so the slider can restore the previous manual speed
     * when leaving wallpad-managed states.
     */
    lastManualRotationSpeed: RotationSpeed

    /**
     * Last climate mode (AUTO/COOLING only). HeaterCooler power-on returns to this mode.
     */
    lastClimateMode: Mode

    currentTemperature: number
    desiredTemperature: number
}

enum RotationSpeed {
    OFF = "off",
    LOW = "low",
    MIDDLE = "middle",
    HIGH = "high",
    AUTO = "auto", // Wallpad-managed wind. Only valid while in cooling mode.
}

enum Mode {
    AUTO = "auto", // In auto mode, adjusting temperature is allowed but the wind is wallpad-managed.
    COOLING = "cool", // In cooling mode, adjusting temperature and wind (incl. "auto") is allowed.
    DEHUMIDIFYING = "dehumi", // In dehumidifying mode, nothing but the power is adjustable.
    FAN = "fan", // In fan mode, adjusting wind (except "auto") is allowed but not temperature.
}

const ROTATION_SPEED_STEP = 100 / 3.0;
const MIN_TEMPERATURE = 18;
const MAX_TEMPERATURE = 30;

/**
 * Per-device, never-persisted bookkeeping.
 * Holds three unrelated concerns keyed off the same device:
 *  - the temperature handle gesture (mirror + pending write, resolved in scheduleSync),
 *  - the command guard that suppresses stale pre-command state pushes,
 *  - and the temperature re-assert guard that forces our setpoint
 *    past the wallpad's own stored per-mode value.
 * See applyWallPadState and scheduleSync for how these interact with incoming pushes.
 */
interface TemperatureGesture {
    coolMirror?: number
    pendingCool?: number
    timer?: NodeJS.Timeout
    parkTimer?: NodeJS.Timeout

    // Command guard: the power/mode we last commanded and expect the wallpad to confirm.
    pendingPower?: boolean
    pendingMode?: Mode
    pendingSince?: number

    // Temperature re-assert guard: the setpoint we insist on and its deadline.
    tempGuardTarget?: number
    tempGuardUntil?: number
    lastReassertAt?: number
}

// Long enough that both writes of one Home app gesture
// (the moved handle plus the app's rewrite of the untouched one) land in the same window,
// short enough that the follower handle visibly snaps over right after the drag.
const GESTURE_WINDOW_MILLISECONDS = 120;

// The Home app tends to ignore a correction that contradicts its own write for a few seconds,
// and once our value is back at the park further syncs emit no event (no change) —
// so the parked handle gets a late forced notification after this delay.
const LATE_PARK_PUSH_MILLISECONDS = 2500;

// After a command, ignore pushes that still carry the pre-command power/mode
// for up to this long (or until the wallpad confirms our power+mode, whichever comes first).
// The wallpad reflects a control op only after a few seconds and would otherwise fight the optimistic UI.
const COMMAND_GUARD_MILLISECONDS = 7000;

// The wallpad drops a set_temp bundled with a mode change and keeps its own stored per-mode setpoint.
// Hold the displayed temperature at our target and re-send a standalone set_temp until the wallpad
// reports it, capped at this window.
const TEMP_GUARD_MILLISECONDS = 10000;

// Minimum spacing between standalone set_temp re-assert commands within the guard window.
const REASSERT_THROTTLE_MILLISECONDS = 1000;

export default class AirConditionerAccessories extends Accessories<AirConditionerInterface> {

    private readonly temperatureGestures: Record<string, TemperatureGesture> = {};

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.AIR_CONDITIONER, [
            api.hap.Service.HeaterCooler,
            api.hap.Service.Fanv2,
            api.hap.Service.HumidifierDehumidifier,
        ]);
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

    private isClimateMode(mode: Mode): boolean {
        return mode === Mode.AUTO || mode === Mode.COOLING;
    }

    private isClimateActive(context: AirConditionerInterface): boolean {
        return context.active && this.isClimateMode(context.mode);
    }

    private isBlowing(context: AirConditionerInterface): boolean {
        return context.active && context.mode !== Mode.DEHUMIDIFYING;
    }

    private isWindAuto(context: AirConditionerInterface): boolean {
        return context.mode === Mode.AUTO || context.rotationSpeed === RotationSpeed.AUTO;
    }

    /**
     * The wallpad accepts integer temperatures within 18..30 only —
     * every value coming from a threshold handle floors into that range.
     */
    private toWallPadTemperature(value: number): number {
        return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, Math.floor(value)));
    }

    /**
     * Wind slider percentage.
     * While the wind is wallpad-managed the slider parks at full so it reads as "auto is in charge";
     * the manual speed stays preserved in `lastManualRotationSpeed` underneath.
     */
    private getDisplayRotationSpeed(context: AirConditionerInterface): number {
        if(!this.isBlowing(context)) {
            return 0;
        }
        if(this.isWindAuto(context)) {
            return 100;
        }
        return this.rotationSpeedToHomebridge(context.lastManualRotationSpeed);
    }

    /**
     * The cooling threshold is the one and only temperature control:
     * the COOL dial and the top handle of the AUTO pair both show the target itself,
     * keeping the two views in the same tone.
     */
    private getDisplayCoolingThreshold(context: AirConditionerInterface): number {
        return this.getThresholdTemperature(context);
    }

    /**
     * The heating threshold exists only so the Home app renders a temperature control in AUTO
     * (it wants a heat/cool pair).
     * It parks one degree BELOW the minimum target,
     * so the cooling handle can travel the whole range in both directions —
     * including down to the minimum itself;
     * writes to it are dropped entirely (see the SET handler).
     */
    private getDisplayHeatingThreshold(): number {
        return MIN_TEMPERATURE - 1;
    }

    getThresholdTemperature(context: AirConditionerInterface): number {
        return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, context.desiredTemperature));
    }

    getCurrentTemperature(context: AirConditionerInterface): number {
        return context.currentTemperature;
    }

    getCurrentState(context: AirConditionerInterface): CharacteristicValue {
        if(!this.isClimateActive(context)) {
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        if(context.desiredTemperature < context.currentTemperature) {
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.COOLING;
        }
        return this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE;
    }

    private getHeaterCoolerTargetState(context: AirConditionerInterface): CharacteristicValue {
        if(context.mode === Mode.AUTO) {
            return this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO;
        }
        return this.api.hap.Characteristic.TargetHeaterCoolerState.COOL;
    }

    private getCurrentDehumidifierState(context: AirConditionerInterface): CharacteristicValue {
        if(context.active && context.mode === Mode.DEHUMIDIFYING) {
            return this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
        }
        return this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }

    private gestureOf(context: AirConditionerInterface): TemperatureGesture {
        let gesture = this.temperatureGestures[context.deviceId];
        if(!gesture) {
            gesture = {};
            this.temperatureGestures[context.deviceId] = gesture;
        }
        return gesture;
    }

    /**
     * Debounced state propagation. The pending cooling write of one gesture is applied
     * here, and every locked/dropped write (parked heating handle, wind in auto, ...)
     * gets its UI reverted by the trailing sync in one pass.
     */
    private scheduleSync(accessory: PlatformAccessory) {
        const gesture = this.gestureOf(this.getAccessoryInterface(accessory));
        if(gesture.timer) {
            clearTimeout(gesture.timer);
        }
        gesture.timer = setTimeout(() => this.flushGesture(accessory), GESTURE_WINDOW_MILLISECONDS);
    }

    /**
     * Commit the debounced gesture now:
     * apply the pending cooling write, sync the UI, and arm the guards.
     * Extracted so an incoming push can force it before applying wallpad state —
     * otherwise a push landing inside the debounce window would reflect ahead of the user's gesture,
     * and the trailing task would then fight it.
     * Committing first arms the command/temperature guards,
     * which then suppress the (stale, pre-command) push that follows,
     * keeping the user's intent authoritative.
     */
    private flushGesture(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const gesture = this.gestureOf(context);
        if(gesture.timer) {
            clearTimeout(gesture.timer);
            gesture.timer = undefined;
        }
        const pending = gesture.pendingCool;
        gesture.pendingCool = undefined;
        if(pending !== undefined) {
            this.applyThresholdTemperature(accessory, this.toWallPadTemperature(pending));
        }
        this.syncAccessoryState(accessory);
        this.armCommandGuards(context);
    }

    /**
     * Arm the command + temperature guards from the just-committed optimistic context,
     * so incoming pushes (see applyWallPadState) can tell our own command's settling from stale pre-command state.
     * Called only from the user-action path (scheduleSync), never when applying wallpad state,
     * so incoming state never re-arms the guards.
     */
    private armCommandGuards(context: AirConditionerInterface) {
        const gesture = this.gestureOf(context);
        gesture.pendingPower = context.active;
        gesture.pendingMode = context.mode;
        gesture.pendingSince = Date.now();
        if(this.isClimateActive(context)) {
            gesture.tempGuardTarget = this.getThresholdTemperature(context) as number;
            gesture.tempGuardUntil = Date.now() + TEMP_GUARD_MILLISECONDS;
            // Not seeded to "now": the first contradicting push must re-assert immediately;
            // a fast wallpad override would otherwise be swallowed by the throttle.
            gesture.lastReassertAt = 0;
        } else {
            gesture.tempGuardUntil = undefined; // temp isn't a control off/dehumidifying
        }
    }

    /**
     * WallPad state -> context, gated by the command + temperature guards.
     * Mutates the existing context in place (unlike first-sight creation),
     * so fields the op does not report — lastManualRotationSpeed, lastClimateMode — persist naturally.
     */
    private applyWallPadState(accessory: PlatformAccessory, op: any) {
        const context = this.getAccessoryInterface(accessory);
        this.normalizeContext(context); // in case a push lands before configureAccessory
        const gesture = this.gestureOf(context);
        const reportedPower = op["status"] === "on";
        const reportedMode = (op["mode"] as Mode) || context.mode;

        // Command guard: drop stale pushes that still carry the pre-command power/mode.
        if(gesture.pendingSince !== undefined) {
            const confirmed = reportedPower === gesture.pendingPower
                && (!reportedPower || reportedMode === gesture.pendingMode);
            if(confirmed) {
                gesture.pendingSince = undefined; // wallpad caught up — live again
            } else if(Date.now() - gesture.pendingSince < COMMAND_GUARD_MILLISECONDS) {
                return; // pre-command state still in flight — ignore
            } else {
                gesture.pendingSince = undefined; // cap reached — adopt whatever comes
            }
        }

        // Temperature re-assert guard: hold our target on screen and re-send it
        // while the wallpad reports its own stored setpoint.
        // Held for the whole window (never released on the first match)
        // because the wallpad echoes our value once, then snaps back to its stored per-mode value.
        let holdTemp = false;
        const reportedTemp = Number(op["desired_temp"] ?? op["set_temp"]);
        if(gesture.tempGuardUntil !== undefined && reportedPower && this.isClimateMode(reportedMode)) {
            if(Date.now() >= gesture.tempGuardUntil) {
                gesture.tempGuardUntil = undefined; // cap reached — adopt whatever comes
            } else {
                holdTemp = true;
                if(!Number.isNaN(reportedTemp) && reportedTemp !== gesture.tempGuardTarget
                    && Date.now() - (gesture.lastReassertAt ?? 0) > REASSERT_THROTTLE_MILLISECONDS) {
                    gesture.lastReassertAt = Date.now();
                    this.reassertThresholdTemperature(context, reportedMode, gesture.tempGuardTarget as number);
                }
            }
        }

        context.active = reportedPower;
        context.mode = reportedMode;
        if(op["current_temp"]) {
            context.currentTemperature = Number(op["current_temp"]);
        }
        if(holdTemp) {
            context.desiredTemperature = gesture.tempGuardTarget as number;
        } else {
            const target = op["desired_temp"] ?? op["set_temp"];
            if(target) {
                context.desiredTemperature = Number(target);
            }
        }
        const windSpeed = op["wind_speed"] as RotationSpeed | undefined;
        context.rotationSpeed = reportedPower ? (windSpeed || RotationSpeed.OFF) : RotationSpeed.OFF;
        if(windSpeed === RotationSpeed.LOW || windSpeed === RotationSpeed.MIDDLE || windSpeed === RotationSpeed.HIGH) {
            context.lastManualRotationSpeed = windSpeed;
        }
        if(this.isClimateMode(context.mode)) {
            context.lastClimateMode = context.mode;
        }
        context.init = true;

        this.syncAccessoryState(accessory);
    }

    /**
     * Fire a standalone set_temp so the wallpad adopts our value
     * even after it dropped the set_temp bundled with a mode change.
     * Sent immediately (not deferred): the guard needs the correction to reach the wallpad within its window.
     */
    private reassertThresholdTemperature(context: AirConditionerInterface, mode: Mode, target: number) {
        const device = this.findDevice(context.deviceId);
        if(!device) {
            return;
        }
        void this.setDeviceState({
            ...device, op: {
                control: "on",
                mode: mode.toString(),
                set_temp: target,
            },
        }).catch(() => { /* best-effort correction; the guard retries on the next push */ });
    }

    private applyThresholdTemperature(accessory: PlatformAccessory, target: number) {
        const context = this.getAccessoryInterface(accessory);
        if(context.desiredTemperature === target) {
            return;
        }
        const device = this.findDevice(context.deviceId);
        if(!device) {
            this.log.warn("Unknown device: %s", context.deviceId);
            return;
        }
        context.desiredTemperature = target;
        this.defer(device.deviceId, this.setDeviceState({
            ...device, op: {
                "set_temp": target,
            },
        }));
    }

    /**
     * WallPad state -> HomeKit. Always `updateCharacteristic`: SET handlers must never
     * re-enter from state propagation, or commands would echo back to the wallpad.
     */
    private syncAccessoryState(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const climate = this.isClimateActive(context);
        const blowing = this.isBlowing(context);
        const dehumidifying = context.active && context.mode === Mode.DEHUMIDIFYING;

        this.getService(accessory, this.api.hap.Service.HeaterCooler)
            .updateCharacteristic(this.api.hap.Characteristic.Active, climate
                ? this.api.hap.Characteristic.Active.ACTIVE
                : this.api.hap.Characteristic.Active.INACTIVE)
            .updateCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState, this.getCurrentState(context))
            .updateCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState, this.getHeaterCoolerTargetState(context))
            .updateCharacteristic(this.api.hap.Characteristic.CoolingThresholdTemperature, this.getDisplayCoolingThreshold(context))
            .updateCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature, this.getDisplayHeatingThreshold())
            .updateCharacteristic(this.api.hap.Characteristic.CurrentTemperature, this.getCurrentTemperature(context))
            .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.getDisplayRotationSpeed(context));

        this.getService(accessory, this.api.hap.Service.Fanv2)
            .updateCharacteristic(this.api.hap.Characteristic.Active, blowing
                ? this.api.hap.Characteristic.Active.ACTIVE
                : this.api.hap.Characteristic.Active.INACTIVE)
            .updateCharacteristic(this.api.hap.Characteristic.TargetFanState, this.isWindAuto(context)
                ? this.api.hap.Characteristic.TargetFanState.AUTO
                : this.api.hap.Characteristic.TargetFanState.MANUAL)
            .updateCharacteristic(this.api.hap.Characteristic.CurrentFanState, blowing
                ? this.api.hap.Characteristic.CurrentFanState.BLOWING_AIR
                : this.api.hap.Characteristic.CurrentFanState.INACTIVE)
            .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.getDisplayRotationSpeed(context));

        this.getService(accessory, this.api.hap.Service.HumidifierDehumidifier)
            .updateCharacteristic(this.api.hap.Characteristic.Active, dehumidifying
                ? this.api.hap.Characteristic.Active.ACTIVE
                : this.api.hap.Characteristic.Active.INACTIVE)
            .updateCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState, this.getCurrentDehumidifierState(context))
            .updateCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity, getGlobalIndoorRelativeHumidity());

        const gesture = this.gestureOf(context);
        gesture.coolMirror = this.getDisplayCoolingThreshold(context);
    }

    private async activateMode(accessory: PlatformAccessory, mode: Mode): Promise<boolean> {
        const context = this.getAccessoryInterface(accessory);
        const device = this.findDevice(context.deviceId);
        if(!device) {
            return false;
        }
        const op: Record<string, any> = {
            control: "on",
            mode: mode.toString(),
        };
        if(this.isClimateMode(mode)) {
            op["set_temp"] = this.getThresholdTemperature(context);
        }
        if(mode === Mode.COOLING) {
            // Re-entering cooling restores the previous wind, incl. wallpad-managed "auto".
            op["wind_speed"] = (context.rotationSpeed === RotationSpeed.OFF
                ? context.lastManualRotationSpeed
                : context.rotationSpeed).toString();
        } else if(mode === Mode.FAN) {
            // Fan mode forbids "auto" wind.
            op["wind_speed"] = context.lastManualRotationSpeed.toString();
        }
        const success = await this.setDeviceState({
            ...device,
            op,
        });
        if(!success) {
            return false;
        }
        context.active = true;
        context.mode = mode;
        if(this.isClimateMode(mode)) {
            context.lastClimateMode = mode;
        }
        if(mode === Mode.COOLING && context.rotationSpeed === RotationSpeed.OFF) {
            context.rotationSpeed = context.lastManualRotationSpeed;
        } else if(mode === Mode.FAN) {
            context.rotationSpeed = context.lastManualRotationSpeed;
        }
        return true;
    }

    private async deactivate(accessory: PlatformAccessory): Promise<boolean> {
        const context = this.getAccessoryInterface(accessory);
        const device = this.findDevice(context.deviceId);
        if(!device) {
            return false;
        }
        const success = await this.setDeviceState({
            ...device,
            op: {
                control: "off",
            },
        });
        if(!success) {
            return false;
        }
        context.active = false;
        return true;
    }

    /**
     * Shared handler for both wind sliders (HeaterCooler and Fanv2 both expose
     * RotationSpeed so the wind stays adjustable in combined AND separated tile views).
     */
    private async onSetRotationSpeed(
        accessory: PlatformAccessory,
        value: CharacteristicValue,
        callback: CharacteristicSetCallback,
    ) {
        const context = this.getAccessoryInterface(accessory);
        const numeric = value as number;
        if(numeric <= 0) {
            if(!context.active) {
                callback(undefined);
                return;
            }
            const success = await this.deactivate(accessory);
            if(!success) {
                callback(new Error("Failed to set the device state."));
                return;
            }
            this.scheduleSync(accessory);
            callback(undefined);
            return;
        }
        const wind = this.homebridgeToRotationSpeed(numeric);
        if(!context.active) {
            // The Home app often writes the slider just before Active=1 —
            // remember the speed so the power-on that follows uses it,
            // and revert the slider for now.
            context.lastManualRotationSpeed = wind;
            this.scheduleSync(accessory);
            callback(undefined);
            return;
        }
        if(context.mode === Mode.DEHUMIDIFYING) {
            // Wind isn't a dehumidifying control. Touching it means "I want airflow" —
            // leave dehumidifying and start fan mode at that speed instead of doing nothing.
            context.lastManualRotationSpeed = wind;
            const success = await this.activateMode(accessory, Mode.FAN);
            if(!success) {
                callback(new Error("Failed to set the device state."));
                return;
            }
            this.scheduleSync(accessory);
            callback(undefined);
            return;
        }
        if(context.mode !== Mode.COOLING && context.mode !== Mode.FAN) {
            // auto: the wallpad forbids wind control — revert.
            this.scheduleSync(accessory);
            callback(undefined);
            return;
        }
        if(context.rotationSpeed === wind) {
            callback(undefined);
            return;
        }
        const device = this.findDevice(context.deviceId);
        if(!device) {
            callback(new Error(`Unknown device: ${context.deviceId}`));
            return;
        }
        context.rotationSpeed = wind;
        context.lastManualRotationSpeed = wind;
        this.defer(device.deviceId, this.setDeviceState({
            ...device, op: {
                "wind_speed": wind.toString(),
            },
        }));
        this.scheduleSync(accessory);
        callback(undefined);
    }

    /**
     * Migrate a context restored from an older cache:
     * `lastManualRotationSpeed` and `lastClimateMode` did not exist before this rework,
     * so a cached accessory carries them as undefined.
     * Seed sane defaults before any handler can read them —
     * otherwise powering on would command `mode: "undefined"` or throw on `undefined.toString()`.
     */
    private normalizeContext(context: AirConditionerInterface) {
        if(context.lastManualRotationSpeed === undefined) {
            const wind = context.rotationSpeed;
            context.lastManualRotationSpeed = (wind === RotationSpeed.LOW
                || wind === RotationSpeed.MIDDLE
                || wind === RotationSpeed.HIGH) ? wind : RotationSpeed.LOW;
        }
        if(context.lastClimateMode === undefined) {
            context.lastClimateMode = this.isClimateMode(context.mode) ? context.mode : Mode.COOLING;
        }
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.normalizeContext(this.getAccessoryInterface(accessory));

        const heaterCooler = this.getService(accessory, this.api.hap.Service.HeaterCooler);
        heaterCooler.setPrimaryService(true);

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                if(this.isClimateActive(context) === active) {
                    callback(undefined);
                    return;
                }
                if(active) {
                    const success = await this.activateMode(accessory, context.lastClimateMode);
                    if(!success) {
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                } else if(this.isClimateMode(context.mode)) {
                    const success = await this.deactivate(accessory);
                    if(!success) {
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.isClimateActive(context)
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.CurrentHeaterCoolerState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE,
                    this.api.hap.Characteristic.CurrentHeaterCoolerState.COOLING,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentState(this.getAccessoryInterface(accessory)));
            });

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.TargetHeaterCoolerState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO,
                    this.api.hap.Characteristic.TargetHeaterCoolerState.COOL,
                ],
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const targetMode = value === this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO
                    ? Mode.AUTO
                    : Mode.COOLING;
                if(context.mode === targetMode) {
                    callback(undefined);
                    return;
                }
                context.lastClimateMode = targetMode;
                if(!context.active) {
                    context.mode = targetMode;
                    this.scheduleSync(accessory);
                    callback(undefined);
                    return;
                }
                const success = await this.activateMode(accessory, targetMode);
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getHeaterCoolerTargetState(this.getAccessoryInterface(accessory)));
            });

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.CoolingThresholdTemperature)
            .setProps({
                // Matches the parked heating handle (min - 1):
                // the Home app renders the AUTO pair on one shared track bounded by this range,
                // and a floor of 18 would clamp the parked handle up to 18 on every gesture.
                // Targets still clamp into 18..30 on write.
                minValue: MIN_TEMPERATURE - 1,
                maxValue: MAX_TEMPERATURE,
                minStep: 1,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const gesture = this.gestureOf(context);
                if(value !== gesture.coolMirror
                    && context.active && this.isClimateMode(context.mode)) {
                    gesture.pendingCool = value as number;
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getDisplayCoolingThreshold(this.getAccessoryInterface(accessory)));
            });

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
            .setProps({
                minValue: MIN_TEMPERATURE - 1,
                maxValue: MAX_TEMPERATURE,
                minStep: 1,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // The heating handle is parked and is not a control: every write —
                // user drags and the Home app's own "heat = cool - 1" rewrites alike —
                // is dropped, and the trailing sync snaps it back. The late forced
                // notification covers the app ignoring that immediate correction.
                if(value !== this.getDisplayHeatingThreshold()) {
                    const gesture = this.gestureOf(this.getAccessoryInterface(accessory));
                    if(gesture.parkTimer) {
                        clearTimeout(gesture.parkTimer);
                    }
                    gesture.parkTimer = setTimeout(() => {
                        gesture.parkTimer = undefined;
                        this.getService(accessory, this.api.hap.Service.HeaterCooler)
                            .getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
                            .sendEventNotification(this.getDisplayHeatingThreshold());
                    }, LATE_PARK_PUSH_MILLISECONDS);
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getDisplayHeatingThreshold());
            });

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentTemperature(this.getAccessoryInterface(accessory)));
            });

        heaterCooler.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.onSetRotationSpeed(accessory, value, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getDisplayRotationSpeed(this.getAccessoryInterface(accessory)));
            });

        this.configureFan(accessory);
        this.configureDehumidifier(accessory);
    }

    private configureFan(accessory: PlatformAccessory): Service {
        const fan = this.getService(accessory, this.api.hap.Service.Fanv2);
        fan.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(value === this.api.hap.Characteristic.Active.ACTIVE) {
                    if(!context.active || context.mode === Mode.DEHUMIDIFYING) {
                        const success = await this.activateMode(accessory, Mode.FAN);
                        if(!success) {
                            callback(new Error("Failed to set the device state."));
                            return;
                        }
                    }
                    // cool/auto: already blowing — nothing to do.
                } else {
                    if(context.active && context.mode === Mode.FAN) {
                        const success = await this.deactivate(accessory);
                        if(!success) {
                            callback(new Error("Failed to set the device state."));
                            return;
                        }
                    }
                    // cool/auto: cannot stop only the fan — revert via sync.
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.isBlowing(context)
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });

        fan.getCharacteristic(this.api.hap.Characteristic.TargetFanState)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                if(value === this.api.hap.Characteristic.TargetFanState.AUTO) {
                    // Wallpad-managed wind is a cooling-only feature; auto mode is
                    // already wallpad-managed and fan mode forbids it — revert those.
                    if(context.active && context.mode === Mode.COOLING
                        && context.rotationSpeed !== RotationSpeed.AUTO) {
                        context.rotationSpeed = RotationSpeed.AUTO;
                        this.defer(device.deviceId, this.setDeviceState({
                            ...device, op: {
                                "wind_speed": RotationSpeed.AUTO.toString(),
                            },
                        }));
                    }
                } else {
                    if(context.active && context.mode === Mode.COOLING
                        && context.rotationSpeed === RotationSpeed.AUTO) {
                        context.rotationSpeed = context.lastManualRotationSpeed;
                        this.defer(device.deviceId, this.setDeviceState({
                            ...device, op: {
                                "wind_speed": context.lastManualRotationSpeed.toString(),
                            },
                        }));
                    }
                    // auto mode: wind is wallpad-managed — MANUAL requests revert via sync.
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.isWindAuto(context)
                    ? this.api.hap.Characteristic.TargetFanState.AUTO
                    : this.api.hap.Characteristic.TargetFanState.MANUAL);
            });

        fan.getCharacteristic(this.api.hap.Characteristic.CurrentFanState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.isBlowing(context)
                    ? this.api.hap.Characteristic.CurrentFanState.BLOWING_AIR
                    : this.api.hap.Characteristic.CurrentFanState.INACTIVE);
            });

        fan.getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                await this.onSetRotationSpeed(accessory, value, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getDisplayRotationSpeed(this.getAccessoryInterface(accessory)));
            });
        return fan;
    }

    private configureDehumidifier(accessory: PlatformAccessory): Service {
        const service = this.getService(accessory, this.api.hap.Service.HumidifierDehumidifier);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                const dehumidifying = context.active && context.mode === Mode.DEHUMIDIFYING;
                if(dehumidifying === active) {
                    callback(undefined);
                    return;
                }
                if(active) {
                    const success = await this.activateMode(accessory, Mode.DEHUMIDIFYING);
                    if(!success) {
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                } else {
                    const success = await this.deactivate(accessory);
                    if(!success) {
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                }
                this.scheduleSync(accessory);
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const active = context.active && context.mode === Mode.DEHUMIDIFYING;
                callback(undefined, active
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });
        service.getCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
                    this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
                ],
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getCurrentDehumidifierState(this.getAccessoryInterface(accessory)));
            });
        service.getCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState)
            .setProps({
                validValues: [
                    this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
                ],
            })
            .updateValue(this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);
            });
        service.getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, getGlobalIndoorRelativeHumidity());
            });
        return service;
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                // Existing accessory: still run it through addOrGetAccessory,
                // so the "disabled in config -> unregister" path there keeps owning removal.
                // Feed it the current context (not the push),
                // so a surviving accessory is re-assigned to itself unchanged,
                // then let applyWallPadState apply the push in place through the command/temperature guards.
                const existing = this.findAccessory(device.deviceId);
                if(existing) {
                    const kept = this.addOrGetAccessory(this.getAccessoryInterface(existing));
                    if(!kept) continue; // disabled -> unregistered
                    // A gesture still mid-debounce must be committed before the push is applied,
                    // so the user's intent lands (and arms the guards) first.
                    if(this.gestureOf(this.getAccessoryInterface(kept)).timer) {
                        this.flushGesture(kept);
                    }
                    this.applyWallPadState(kept, device.op);
                    continue;
                }

                // First sight: build the full initial context and create the accessory.
                const active = device.op["status"] === "on";
                const currentTemperature = device.op["current_temp"] ? Number(device.op["current_temp"]) : MIN_TEMPERATURE;
                const targetTemperature = device.op["desired_temp"] ?? device.op["set_temp"];
                const desiredTemperature = targetTemperature ? Number(targetTemperature) : MIN_TEMPERATURE;
                const windSpeed = device.op["wind_speed"] as RotationSpeed | undefined;
                const rotationSpeed = active ? (windSpeed || RotationSpeed.OFF) : RotationSpeed.OFF;
                const operationMode = device.op["mode"] as Mode || Mode.AUTO;
                const isManualWind = windSpeed === RotationSpeed.LOW
                    || windSpeed === RotationSpeed.MIDDLE
                    || windSpeed === RotationSpeed.HIGH;

                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    currentTemperature,
                    desiredTemperature,
                    rotationSpeed,
                    lastManualRotationSpeed: isManualWind ? windSpeed : RotationSpeed.LOW,
                    lastClimateMode: this.isClimateMode(operationMode) ? operationMode : Mode.COOLING,
                    mode: operationMode,
                });
                if(!accessory) continue;

                this.syncAccessoryState(accessory);
            }
        });
    }
}
