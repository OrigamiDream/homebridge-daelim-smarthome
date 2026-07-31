import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory, Service
} from "homebridge";
import {Device, DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Accessories, {AccessoryInterface, DeviceWithOp} from "./accessories";
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
     *
     * Written from two places and no other: a mode the user names in HomeKit, and a
     * report of a *running* climate mode. A powered-off report also carries a mode -
     * the one the WallPad has stored - and adopting that would walk back a mode picked
     * while off, which sends no command and so is a choice only this field remembers.
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

// The Home app tends to ignore a correction that contradicts its own write for a few seconds,
// and once our value is back at the park further syncs emit no event (no change) —
// so the parked handle gets a late forced notification after this delay.
const LATE_PARK_PUSH_MILLISECONDS = 2500;

/**
 * How long a command may wait for a device report to answer it.
 *
 * Measured live on 2026-07-31 (13 commands): the WallPad applies a command at once -
 * a query 255ms after acceptance already showed the new state - but publishes its
 * event in its own time, 0.3 to 8.8 seconds, and one bare mode change never produced
 * one within 12. The budget has to clear that spread; what it must never do is fail
 * the gesture, because unconfirmed is late, not failed - see sendDeviceStateAndWait().
 */
const AIRCON_OPERATION_TIMEOUT_MILLISECONDS = 10_000;

/**
 * The writes of one HAP request, gathered before a command is decided.
 *
 * Every field records what HomeKit wrote rather than what it should mean. The writes of
 * one request arrive in no particular order - HAP starts every characteristic write of
 * one request at once - so a handler that decided on the spot would reach a different
 * answer depending on which write happened to land first. Three services stand for this
 * one device, and a scene writes to all of them together: whether `Active: 0` on the
 * fan means "stop" depends on whether anything else in the request named a mode, and
 * that is not knowable until the writes have all landed.
 *
 * What the writes mean is decided in `carryOutGesture()`, when the gesture's turn in
 * the device queue comes, against the device as it stands then - the fold that keeps a
 * late write from replaying the state it happened to be written against.
 */
interface PendingGesture {
    /** Where this gesture sits in the order they arrived - see the pass-over lanes. */
    seq: number
    /** HeaterCooler `Active`: the climate side asked on or off. */
    climateActive?: boolean
    /** Fanv2 `Active`. */
    fanActive?: boolean
    /** HumidifierDehumidifier `Active`. */
    dehumidifierActive?: boolean
    /** `TargetHeaterCoolerState`, as the mode it names. */
    climateMode?: Mode
    /** `TargetFanState`: true asked for wallpad-managed wind, false for manual. */
    windAuto?: boolean
    /**
     * The last `RotationSpeed` HomeKit wrote, zero included. A drag reaches the
     * accessory as one write per request, so the last of them is the one the finger
     * stopped on: passing over zero on the way to a speed is not a request to stop.
     */
    speedWrite?: number
    /** The last `CoolingThresholdTemperature` written, unclamped. */
    coolWrite?: number
}

/** What a gesture resolved to, in device terms, judged against the context at dequeue. */
interface GestureDecision {
    wantedActive: boolean
    mode: Mode
    wind?: RotationSpeed
    temperature?: number
}

interface PendingConfirmation {
    operation: Record<string, any>
    complete: (confirmed: boolean) => void
}

export default class AirConditionerAccessories extends Accessories<AirConditionerInterface> {

    private readonly deviceOperationQueues = new Map<string, Promise<void>>();
    private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
    /**
     * Reports observed before this number cannot describe the command that set it.
     *
     * Drawn from the client's observation counter as each command goes out and again as
     * it settles, the way the light and vent accessories keep it. A websocket push is
     * stamped when it is received, so it always passes; only a poll that was already in
     * the air when the command was sent falls below - and that is exactly the report
     * whose shape can still match the pending op and confirm it falsely, or rewrite the
     * context with the state the command was sent to leave.
     */
    private readonly staleBefore = new Map<string, number>();
    private readonly gestures = new Map<string, PendingGesture>();
    /** Gestures seen so far, per device, numbering each so a queued one can be overtaken. */
    private readonly gestureSeq = new Map<string, number>();
    /**
     * The newest gesture that carries nothing but a temperature, per device.
     *
     * A drag is a run of requests rather than one, and with every command confirmed
     * against a device report before the next, the queue holds several of its steps at
     * once. A temperature is one scalar, so a newer temperature-only gesture replaces
     * an older one outright - the light accessory's pass-over, borrowed for a gesture
     * shape it is true of. Gestures that carry power or a mode are never passed over:
     * they carry intents a later temperature does not restate, and dropping them is how
     * the vent once lost a named mode (the bug cb7707c fixed).
     */
    private readonly newestTemperatureOnlySeq = new Map<string, number>();
    /** The speed lane of the same pass-over. The two lanes never take each other's gestures. */
    private readonly newestSpeedOnlySeq = new Map<string, number>();
    /**
     * How many gathered gestures are being carried out on each device right now.
     *
     * While any are, reports keep the context current but the characteristics wait, so
     * the accessory shows the result of a gesture rather than the route the WallPad
     * takes to it. A count rather than a flag: two gestures overlap easily, and the
     * first to finish must not release the hold while the second is still commanding.
     */
    private readonly runningGestures = new Map<string, number>();
    /** Late forced notifications for the parked heating handle, per device. */
    private readonly parkTimers = new Map<string, NodeJS.Timeout>();
    private operationTimeoutMilliseconds = AIRCON_OPERATION_TIMEOUT_MILLISECONDS;

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

    /**
     * While the climate side runs, the mode it is in; while it does not, the mode a
     * power-on would start. The latter is what keeps a mode picked while off on
     * screen: that pick sends no command, so the WallPad keeps reporting the mode it
     * has stored, and a display read off `context.mode` would walk the pick back on
     * the next poll.
     */
    private getHeaterCoolerTargetState(context: AirConditionerInterface): CharacteristicValue {
        const displayed = this.isClimateActive(context) ? context.mode : context.lastClimateMode;
        if(displayed === Mode.AUTO) {
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

    // ---- gestures ------------------------------------------------------------

    /**
     * Gathers one HAP request's writes before anything is decided.
     *
     * hap-nodejs starts every characteristic write of one request without awaiting, and
     * these handlers answer synchronously, so one turn of the event loop is exactly the
     * set of writes that belong together - the `setImmediate` fires with the request
     * whole. Nothing here waits on a clock; the 120ms window this replaces bought the
     * same grouping at the price of a fixed delay. Late writes become gestures of their
     * own and are read against the device only after the earlier ones have run, which
     * is what makes them harmless.
     */
    private recordGesture(accessory: PlatformAccessory, apply: (gesture: PendingGesture) => void) {
        const context = this.getAccessoryInterface(accessory);
        let gesture = this.gestures.get(context.deviceId);
        if(!gesture) {
            const seq = (this.gestureSeq.get(context.deviceId) || 0) + 1;
            this.gestureSeq.set(context.deviceId, seq);
            gesture = { seq };
            this.gestures.set(context.deviceId, gesture);
            setImmediate(() => {
                void this.flushGesture(accessory);
            });
        }
        apply(gesture);
    }

    /**
     * Hands the gathered writes to the device queue. The deciding all happens in
     * `carryOutGesture()` when the queue gets there; this only keeps the reflection
     * hold unbroken from the first write to the last command.
     */
    private async flushGesture(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const gesture = this.gestures.get(context.deviceId);
        if(!gesture) {
            return;
        }
        this.gestures.delete(context.deviceId);
        this.beginGesture(context.deviceId);
        if(this.isTemperatureOnlyGesture(gesture)) {
            this.newestTemperatureOnlySeq.set(context.deviceId, gesture.seq);
        }
        if(this.isSpeedOnlyGesture(gesture)) {
            this.newestSpeedOnlySeq.set(context.deviceId, gesture.seq);
        }

        try {
            const device = this.findDevice(context.deviceId);
            if(!device) {
                this.log.warn("Unknown device: %s", context.deviceId);
                return;
            }
            await this.enqueueDeviceOperation(device.deviceId, async () =>
                await this.carryOutGesture(accessory, device, gesture));
        } catch(error: any) {
            this.log.warn("Air conditioner control request failed: %s", error?.message || error);
        } finally {
            // Released before the state is put back, and in a `finally` so a command
            // that threw cannot leave the accessory frozen on a state it has left.
            this.endGesture(context.deviceId);
        }
        // Whatever the device settled on goes back onto the characteristics, which is
        // also what reverts every locked or dropped write - the parked heating handle,
        // wind in a wallpad-managed mode, a temperature on a powered-off unit. It does
        // nothing while another gesture on this device is still commanding.
        this.applyAccessoryState(accessory);
    }

    /** Nothing but a temperature - the one shape a newer temperature replaces. */
    private isTemperatureOnlyGesture(gesture: PendingGesture): boolean {
        return gesture.coolWrite !== undefined
            && gesture.speedWrite === undefined
            && gesture.climateActive === undefined
            && gesture.fanActive === undefined
            && gesture.dehumidifierActive === undefined
            && gesture.climateMode === undefined
            && gesture.windAuto === undefined;
    }

    /** Nothing but a speed - the other lane, replaced only by a newer speed. */
    private isSpeedOnlyGesture(gesture: PendingGesture): boolean {
        return gesture.speedWrite !== undefined
            && gesture.coolWrite === undefined
            && gesture.climateActive === undefined
            && gesture.fanActive === undefined
            && gesture.dehumidifierActive === undefined
            && gesture.climateMode === undefined
            && gesture.windAuto === undefined;
    }

    /**
     * What the gesture asks the device to become, judged against the context as it
     * stands when the gesture's turn comes. Every rule here is one of the old SET
     * handlers, moved from "when the write arrived" to "when the queue got here":
     *
     *  - Only an `Active` write powers the unit on. A mode, temperature or speed
     *    written to a powered-off unit stays a local choice - the mode is remembered
     *    for the next power-on, the rest is reverted - which is how these handlers
     *    have always answered them.
     *  - The dehumidifier switch names its mode outright, the AUTO/COOL toggle names a
     *    climate mode, the HeaterCooler power-on returns to the last climate mode, and
     *    Fanv2 names fan only where nothing is blowing yet. When one gesture carries
     *    several of these, the more specific claim wins in that order.
     *  - Touching the speed of a dehumidifying unit means "I want airflow" and moves
     *    it to fan mode, and a speed of zero stops the unit whatever mode it is in.
     *  - Service-scoped `Active: 0` writes stop only their own mode family, judged
     *    against the mode the gesture resolves to - so a scene that names a mode and
     *    clears another service's switch is a mode change, not a stop.
     */
    private resolveGesture(context: AirConditionerInterface, gesture: PendingGesture): GestureDecision {
        const speed = gesture.speedWrite !== undefined
            ? this.homebridgeToRotationSpeed(gesture.speedWrite)
            : undefined;

        // Ascending precedence - later assignments override earlier ones.
        let claimed: Mode | undefined;
        if(speed !== undefined && speed !== RotationSpeed.OFF
            && context.active && context.mode === Mode.DEHUMIDIFYING) {
            claimed = Mode.FAN;
        }
        if(gesture.fanActive === true && (!context.active || context.mode === Mode.DEHUMIDIFYING)) {
            claimed = Mode.FAN;
        }
        if(gesture.climateActive === true && !this.isClimateActive(context)) {
            claimed = context.lastClimateMode;
        }
        if(gesture.climateMode !== undefined) {
            claimed = gesture.climateMode;
        }
        if(gesture.dehumidifierActive === true) {
            claimed = Mode.DEHUMIDIFYING;
        }
        const mode = claimed !== undefined ? claimed : context.mode;

        const stopRequested = (speed !== undefined && speed === RotationSpeed.OFF)
            || (gesture.climateActive === false && this.isClimateMode(mode))
            || (gesture.fanActive === false && mode === Mode.FAN)
            || (gesture.dehumidifierActive === false && mode === Mode.DEHUMIDIFYING);
        const onRequested = gesture.climateActive === true
            || gesture.fanActive === true
            || gesture.dehumidifierActive === true;
        const wantedActive = !stopRequested && (context.active || onRequested);

        if(!wantedActive) {
            return { wantedActive, mode };
        }

        const entering = !context.active || mode !== context.mode;
        // Past the stop check, a recorded speed cannot be zero - the compiler enforces it.
        let wind: RotationSpeed | undefined;
        if(mode === Mode.COOLING) {
            if(speed !== undefined) {
                wind = speed;
            } else if(gesture.windAuto === true) {
                // Wallpad-managed wind is a cooling-only feature.
                wind = RotationSpeed.AUTO;
            } else if(gesture.windAuto === false && context.rotationSpeed === RotationSpeed.AUTO) {
                wind = context.lastManualRotationSpeed;
            } else if(entering) {
                // Re-entering cooling restores the previous wind, incl. wallpad-managed "auto".
                wind = context.rotationSpeed !== RotationSpeed.OFF
                    ? context.rotationSpeed
                    : context.lastManualRotationSpeed;
            }
        } else if(mode === Mode.FAN) {
            if(speed !== undefined) {
                wind = speed;
            } else if(entering) {
                // Fan mode forbids "auto" wind.
                wind = context.lastManualRotationSpeed;
            }
        }
        // auto: the wallpad manages the wind; dehumidifying: wind is not a control.
        // Speed writes in those modes are reverted by the trailing publish.

        let temperature: number | undefined;
        if(this.isClimateMode(mode)) {
            temperature = gesture.coolWrite !== undefined
                ? this.toWallPadTemperature(gesture.coolWrite)
                : (entering ? this.getThresholdTemperature(context) : undefined);
        }
        // fan/dehumi: temperature is not a control there - a coolWrite is reverted.

        return { wantedActive, mode, wind, temperature };
    }

    /**
     * Turns one gesture into at most one command.
     *
     * One command rather than the vent's power-mode-speed sequence, because this
     * WallPad honors a bundle in full: measured on 2026-07-31, `{control, mode,
     * set_temp, wind_speed}` applied every field even across a mode change, including
     * a set_temp that differed from the stored one - the premise behind the old
     * ten-second temperature guard, refuted. A single bundle also sidesteps the
     * WallPad's habit of coalescing rapid commands into one report, which is what
     * would make serial per-field confirmation unreliable here.
     */
    private async carryOutGesture(accessory: PlatformAccessory, device: Device, gesture: PendingGesture): Promise<boolean> {
        const context = this.getAccessoryInterface(accessory);
        if(this.isTemperatureOnlyGesture(gesture)
            && (this.newestTemperatureOnlySeq.get(context.deviceId) || 0) > gesture.seq) {
            // A newer temperature-only gesture is already waiting, so this one is a
            // place the finger passed through rather than anywhere it meant to stop.
            this.log.debug("AirConditioner :: %s :: a newer temperature is waiting, so %s is passed over",
                context.displayName, String(gesture.coolWrite));
            return true;
        }
        if(this.isSpeedOnlyGesture(gesture)
            && (this.newestSpeedOnlySeq.get(context.deviceId) || 0) > gesture.seq) {
            this.log.debug("AirConditioner :: %s :: a newer speed is waiting, so %s is passed over",
                context.displayName, String(gesture.speedWrite));
            return true;
        }

        const baseActive = context.active;
        const baseMode = context.mode;
        const decision = this.resolveGesture(context, gesture);

        // Local memories, kept whether or not a command goes out. A mode named while
        // off is what the next power-on starts; a speed on a stopped or dehumidifying
        // unit is what the slider returns to.
        if(gesture.climateMode !== undefined) {
            context.lastClimateMode = gesture.climateMode;
        }
        const speed = gesture.speedWrite !== undefined
            ? this.homebridgeToRotationSpeed(gesture.speedWrite)
            : undefined;
        if(speed === RotationSpeed.LOW || speed === RotationSpeed.MIDDLE || speed === RotationSpeed.HIGH) {
            // Not into auto mode: there the wind is not a choice being made, and the
            // write is reverted rather than remembered - as it always was.
            if(!(decision.wantedActive && decision.mode === Mode.AUTO)) {
                context.lastManualRotationSpeed = speed;
            }
        }

        this.log.debug("AirConditioner :: %s :: gesture [%s] asks active=%s mode=%s wind=%s temp=%s (from active=%s mode=%s wind=%s temp=%s)",
            context.displayName, this.describeGesture(gesture),
            decision.wantedActive ? "on" : "off", decision.mode,
            decision.wind !== undefined ? decision.wind : "-",
            decision.temperature !== undefined ? String(decision.temperature) : "-",
            baseActive ? "on" : "off", baseMode, context.rotationSpeed, String(context.desiredTemperature));

        if(!decision.wantedActive) {
            if(this.getAccessoryInterface(accessory).active) {
                return await this.sendDeviceStateAndWait({...device, op: {control: "off"}});
            }
            return true;
        }

        const op: Record<string, any> = {};
        if(!baseActive || decision.mode !== baseMode) {
            // The shape #179 shipped: power and mode with their dependent fields in one op.
            op["control"] = "on";
            op["mode"] = decision.mode.toString();
            if(decision.temperature !== undefined) {
                op["set_temp"] = decision.temperature;
            }
            if(decision.wind !== undefined) {
                op["wind_speed"] = decision.wind.toString();
            }
        } else {
            if(decision.temperature !== undefined
                && decision.temperature !== this.getThresholdTemperature(context)) {
                op["set_temp"] = decision.temperature;
            }
            if(decision.wind !== undefined && decision.wind !== context.rotationSpeed) {
                op["wind_speed"] = decision.wind.toString();
            }
        }
        if(Object.keys(op).length === 0) {
            this.log.debug("AirConditioner :: %s :: the gesture asks for nothing the device is not already doing",
                context.displayName);
            return true;
        }
        return await this.sendDeviceStateAndWait({...device, op});
    }

    /** One line saying what the gesture carried, for the log. */
    private describeGesture(gesture: PendingGesture): string {
        const writes = [];
        if(gesture.climateActive !== undefined) writes.push(`climate=${gesture.climateActive ? "on" : "off"}`);
        if(gesture.fanActive !== undefined) writes.push(`fan=${gesture.fanActive ? "on" : "off"}`);
        if(gesture.dehumidifierActive !== undefined) writes.push(`dehumi=${gesture.dehumidifierActive ? "on" : "off"}`);
        if(gesture.climateMode !== undefined) writes.push(`mode=${gesture.climateMode}`);
        if(gesture.windAuto !== undefined) writes.push(gesture.windAuto ? "windAUTO" : "windMANUAL");
        if(gesture.speedWrite !== undefined) writes.push(`speed=${gesture.speedWrite.toFixed(0)}`);
        if(gesture.coolWrite !== undefined) writes.push(`temp=${gesture.coolWrite}`);
        return writes.join(" ") || "nothing";
    }

    private beginGesture(deviceId: string) {
        this.runningGestures.set(deviceId, (this.runningGestures.get(deviceId) || 0) + 1);
    }

    private endGesture(deviceId: string) {
        const running = (this.runningGestures.get(deviceId) || 0) - 1;
        if(running > 0) {
            this.runningGestures.set(deviceId, running);
        } else {
            this.runningGestures.delete(deviceId);
        }
    }

    // ---- commands and confirmation -------------------------------------------

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
        if(operation["set_temp"] !== undefined) {
            compared = true;
            const reported = state["desired_temp"] ?? state["set_temp"];
            if(String(reported) !== String(operation["set_temp"])) return false;
        }
        return compared;
    }

    private createDeviceConfirmation(deviceId: string, operation: Record<string, any>) {
        let completed = false;
        let timer: NodeJS.Timeout | undefined;
        let complete: (confirmed: boolean) => void = () => undefined;
        const promise = new Promise<boolean>((resolve) => {
            complete = (confirmed: boolean) => {
                if(completed) return;
                completed = true;
                if(timer) clearTimeout(timer);
                this.pendingConfirmations.delete(deviceId);
                resolve(confirmed);
            };
        });

        // The budget opens when the server accepts the command, not when the request
        // leaves - the waiter is still installed before the request, because a report
        // can outrun the HTTP response, but the deadline only makes sense from acceptance.
        const arm = () => {
            if(completed || timer) return;
            timer = setTimeout(() => {
                this.log.warn("Air conditioner operation was not confirmed by a device report: %s",
                    JSON.stringify(operation));
                complete(false);
            }, this.operationTimeoutMilliseconds);
            timer.unref();
        };

        this.pendingConfirmations.set(deviceId, {operation, complete});
        return {promise, arm, cancel: () => complete(false)};
    }

    private confirmDeviceOperation(device: DeviceWithOp) {
        const pending = this.pendingConfirmations.get(device.deviceId);
        if(pending && this.operationMatchesDeviceState(pending.operation, device.op)) {
            pending.complete(true);
        }
    }

    /**
     * Sends one op and waits for a device report to answer it.
     *
     * Resolves false only when the server refused the command outright; a network
     * failure still throws. A confirmation that never arrives resolves true once the
     * budget runs out, because unconfirmed is not failed: the one command the live
     * measurement saw go unanswered had in fact been applied - the report was late,
     * not absent - and reading the silence as failure is what once dropped the rest
     * of a gesture on the vent.
     *
     * The WallPad applies a command long before it publishes the event (measured:
     * 255ms against seconds), so right after acceptance the device is asked outright -
     * the light accessory's "believed, and then checked" - and the answer to that
     * query usually confirms the op well before the event would have.
     */
    private async sendDeviceStateAndWait(device: DeviceWithOp): Promise<boolean> {
        // Install the waiter before the HTTP request so a fast report cannot arrive
        // between acceptance and confirmation registration.
        const confirmation = this.createDeviceConfirmation(device.deviceId, device.op);
        // Anything observed before now was observed before this command existed.
        this.staleBefore.set(device.deviceId, this.client.takeObservedSeq());
        const sentAt = Date.now();
        try {
            const accepted = await this.setDeviceState(device);
            if(!accepted) {
                confirmation.cancel();
                return false;
            }
            confirmation.arm();
            void this.client.requestDeviceStatus([DeviceType.AIR_CONDITIONER])
                .catch(() => undefined);
            const confirmed = await confirmation.promise;
            if(confirmed) {
                this.log.debug("AirConditioner :: %s :: %s confirmed in %dms",
                    device.displayName, JSON.stringify(device.op), Date.now() - sentAt);
            }
            return true;
        } catch(error) {
            confirmation.cancel();
            throw error;
        } finally {
            // A poll that was already in the air when this op settled cannot describe
            // its outcome either - the WallPad may not have applied the command when
            // that page was asked for.
            this.staleBefore.set(device.deviceId, this.client.takeObservedSeq());
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

    // ---- state reflection ----------------------------------------------------

    /**
     * WallPad report -> context. No command guard and no temperature guard stand here
     * any more: a report that predates the command in flight never reaches this (see
     * the `staleBefore` gate in `register()`), and one that follows it is the WallPad
     * speaking about the command itself - measured, it applies a command at once.
     * Mutates the existing context in place, so fields a report does not decide -
     * `lastManualRotationSpeed`, `lastClimateMode` - persist naturally.
     */
    private applyWallPadState(accessory: PlatformAccessory, op: any) {
        const context = this.getAccessoryInterface(accessory);
        this.normalizeContext(context); // in case a report lands before configureAccessory
        const reportedPower = op["status"] === "on"
            ? true
            : op["status"] === "off"
                ? false
                : context.active;
        const reportedMode = (op["mode"] as Mode) || context.mode;

        context.active = reportedPower;
        context.mode = reportedMode;
        if(op["current_temp"]) {
            context.currentTemperature = Number(op["current_temp"]);
        }
        const target = op["desired_temp"] ?? op["set_temp"];
        if(target) {
            context.desiredTemperature = Number(target);
        }
        const windSpeed = op["wind_speed"] as RotationSpeed | undefined;
        context.rotationSpeed = reportedPower ? (windSpeed || RotationSpeed.OFF) : RotationSpeed.OFF;
        if(windSpeed === RotationSpeed.LOW || windSpeed === RotationSpeed.MIDDLE || windSpeed === RotationSpeed.HIGH) {
            context.lastManualRotationSpeed = windSpeed;
        }
        // Only a *running* climate mode is one somebody chose. A powered-off report
        // carries the mode the WallPad has stored, and a mode picked while off exists
        // nowhere but here - adopting the stored one would walk the pick back.
        if(reportedPower && this.isClimateMode(reportedMode)) {
            context.lastClimateMode = reportedMode;
        }
        context.init = true;

        this.applyAccessoryState(accessory);
    }

    /**
     * The single place where device state reaches HomeKit. Every characteristic is
     * written with `updateCharacteristic`, which does not run the SET handlers, so
     * reflecting a state can never bounce a command back at the wallpad.
     */
    private applyAccessoryState(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        // While a gesture is being gathered or carried out, the context still follows
        // the device - only the characteristics wait. The reports the WallPad publishes
        // on the way to a bundle's end state would otherwise walk the tile through
        // every step, and a poll would pull a slider out from under a finger.
        if(this.gestures.has(context.deviceId) || this.runningGestures.has(context.deviceId)) {
            return;
        }
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
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                this.log.debug("AirConditioner :: %s :: SET :: HeaterCooler Active -> %s",
                    this.getAccessoryInterface(accessory).displayName, active ? "on" : "off");
                this.recordGesture(accessory, (gesture) => {
                    gesture.climateActive = active;
                });
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
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const targetMode = value === this.api.hap.Characteristic.TargetHeaterCoolerState.AUTO
                    ? Mode.AUTO
                    : Mode.COOLING;
                this.log.debug("AirConditioner :: %s :: SET :: TargetHeaterCoolerState -> %s",
                    this.getAccessoryInterface(accessory).displayName, targetMode);
                this.recordGesture(accessory, (gesture) => {
                    gesture.climateMode = targetMode;
                });
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
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                this.log.debug("AirConditioner :: %s :: SET :: CoolingThresholdTemperature -> %s",
                    this.getAccessoryInterface(accessory).displayName, String(value));
                this.recordGesture(accessory, (gesture) => {
                    gesture.coolWrite = value as number;
                });
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
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // The heating handle is parked and is not a control: every write —
                // user drags and the Home app's own "heat = cool - 1" rewrites alike —
                // is dropped, and the trailing publish snaps it back. The late forced
                // notification covers the app ignoring that immediate correction.
                if(value !== this.getDisplayHeatingThreshold()) {
                    const context = this.getAccessoryInterface(accessory);
                    const previous = this.parkTimers.get(context.deviceId);
                    if(previous) {
                        clearTimeout(previous);
                    }
                    this.parkTimers.set(context.deviceId, setTimeout(() => {
                        this.parkTimers.delete(context.deviceId);
                        this.getService(accessory, this.api.hap.Service.HeaterCooler)
                            .getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature)
                            .sendEventNotification(this.getDisplayHeatingThreshold());
                    }, LATE_PARK_PUSH_MILLISECONDS));
                }
                // An empty gesture: no field survives, and the trailing publish
                // reverts the handle without waiting for the late notification.
                this.recordGesture(accessory, () => undefined);
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
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                this.onSetRotationSpeed(accessory, value, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getDisplayRotationSpeed(this.getAccessoryInterface(accessory)));
            });

        this.configureFan(accessory);
        this.configureDehumidifier(accessory);
    }

    /**
     * Shared handler for both wind sliders (HeaterCooler and Fanv2 both expose
     * RotationSpeed so the wind stays adjustable in combined AND separated tile views).
     */
    private onSetRotationSpeed(
        accessory: PlatformAccessory,
        value: CharacteristicValue,
        callback: CharacteristicSetCallback,
    ) {
        this.log.debug("AirConditioner :: %s :: SET :: RotationSpeed -> %s",
            this.getAccessoryInterface(accessory).displayName, String(value));
        this.recordGesture(accessory, (gesture) => {
            gesture.speedWrite = value as number;
        });
        callback(undefined);
    }

    private configureFan(accessory: PlatformAccessory): Service {
        const fan = this.getService(accessory, this.api.hap.Service.Fanv2);
        fan.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                this.log.debug("AirConditioner :: %s :: SET :: Fan Active -> %s",
                    this.getAccessoryInterface(accessory).displayName, active ? "on" : "off");
                this.recordGesture(accessory, (gesture) => {
                    gesture.fanActive = active;
                });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.isBlowing(context)
                    ? this.api.hap.Characteristic.Active.ACTIVE
                    : this.api.hap.Characteristic.Active.INACTIVE);
            });

        fan.getCharacteristic(this.api.hap.Characteristic.TargetFanState)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const auto = value === this.api.hap.Characteristic.TargetFanState.AUTO;
                this.log.debug("AirConditioner :: %s :: SET :: TargetFanState -> %s",
                    this.getAccessoryInterface(accessory).displayName, auto ? "AUTO" : "MANUAL");
                this.recordGesture(accessory, (gesture) => {
                    gesture.windAuto = auto;
                });
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
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                this.onSetRotationSpeed(accessory, value, callback);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getDisplayRotationSpeed(this.getAccessoryInterface(accessory)));
            });
        return fan;
    }

    private configureDehumidifier(accessory: PlatformAccessory): Service {
        const service = this.getService(accessory, this.api.hap.Service.HumidifierDehumidifier);
        service.getCharacteristic(this.api.hap.Characteristic.Active)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const active = value === this.api.hap.Characteristic.Active.ACTIVE;
                this.log.debug("AirConditioner :: %s :: SET :: Dehumidifier Active -> %s",
                    this.getAccessoryInterface(accessory).displayName, active ? "on" : "off");
                this.recordGesture(accessory, (gesture) => {
                    gesture.dehumidifierActive = active;
                });
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

        this.addDeviceListener((devices, metadata) => {
            for(const device of devices) {
                const staleBefore = this.staleBefore.get(device.deviceId);
                if(staleBefore !== undefined && metadata.observedSeq < staleBefore) {
                    // Dropped before it touches anything. Applied, it would rewrite the
                    // context with the state the command in flight was sent to leave -
                    // and its shape can even match the pending op, confirming a command
                    // the device has not answered. The air conditioner is polled every
                    // thirty seconds, so a poll straddling a command is a matter of time.
                    this.log.debug("AirConditioner :: %s :: ignoring a report observed before the command in flight",
                        device.displayName);
                    continue;
                }

                // Existing accessory: still run it through addOrGetAccessory,
                // so the "disabled in config -> unregister" path there keeps owning removal.
                const existing = this.findAccessory(device.deviceId);
                if(existing) {
                    const kept = this.addOrGetAccessory(this.getAccessoryInterface(existing));
                    if(kept) {
                        this.applyWallPadState(kept, device.op);
                    }
                    this.confirmDeviceOperation(device);
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
                if(!accessory) {
                    this.confirmDeviceOperation(device);
                    continue;
                }

                this.applyAccessoryState(accessory);
                this.confirmDeviceOperation(device);
            }
        });
    }
}
