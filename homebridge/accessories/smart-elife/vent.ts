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
    /**
     * Whether the device has ever reported a `mode` of its own, rather than `mode`
     * being the automatic driving this class falls back to. A vent that reports none
     * has no modes to name, so a mode command to it names something that does not
     * exist there - see `resolveWantedMode()`.
     */
    modeReported: boolean
    /**
     * Whether the latest report carried a `wind_speed` at all, which is the device's own
     * account of whether the mode it is in has a speed to choose. Deliberately not sticky:
     * `isFanSpeedControllableMode()` is a denylist and cannot know about a mode this plugin
     * has never seen, so a mode that turns out to have no speed is recognised by the field
     * being absent rather than by being on the list.
     */
    speedReported: boolean
}

interface PendingVentConfirmation {
    operation: Record<string, any>
    complete: (confirmed: boolean) => void
}

/**
 * The writes of one HAP request, gathered before a command is decided.
 *
 * Every field here records what HomeKit wrote rather than what it should mean. The writes
 * of one request arrive in no particular order - HAP starts every characteristic write of
 * one request at once - so a handler that decided on the spot would reach a different
 * answer depending on which write happened to land first. Turning a mode switch off means
 * "stop" only if nothing else named a mode, and a zero speed means "stop" only if it was
 * the last thing the drag said; neither is knowable until the writes have all landed.
 *
 * What the writes mean is decided in `carryOutGesture()`, when the gesture's turn in the
 * device queue comes, against the device as it stands then. A gesture queued behind
 * another has to see where that one is taking the device: on 2026-07-31 at 02:04:36 a
 * stray MANUAL write landed while a cleaning command was in flight, was judged against
 * the automatic mode the vent was in the middle of leaving, and went out as the plain
 * ventilation that undid the cleaning just applied. Judged after the queue has drained,
 * that MANUAL reads against the cleaning the vent actually reached, where it asks for
 * nothing at all.
 */
interface PendingGesture {
    /** Where this gesture sits in the order they arrived - see `newestSpeedOnlySeq`. */
    seq: number
    /** Set by an explicit `Active` write and by nothing else. */
    active?: boolean
    /** The last mode named by a mode switch, as the protocol value the switch stands for. */
    namedMode?: string
    /** Mode switches turned off in this gesture. */
    clearedModes: Set<string>
    /** `TargetAirPurifierState` went to AUTO, which names automatic driving. */
    autoRequested?: boolean
    /** `TargetAirPurifierState` went to MANUAL, which names no mode of its own. */
    manualRequested?: boolean
    /**
     * The last speed HomeKit wrote, `OFF` included. A drag reaches the accessory as one
     * write per step, so the last of them is the one the finger stopped on: passing over
     * zero on the way to a speed is not a request to stop, and stopping on zero is.
     */
    speedWrite?: RotationSpeed
}

export default class VentAccessories extends ActiveAccessories<VentAccessoryInterface> {
    private readonly deviceOperationQueues = new Map<string, Promise<void>>();
    private readonly pendingConfirmations = new Map<string, PendingVentConfirmation>();
    /**
     * Reports observed before this number cannot describe the command that set it.
     *
     * Drawn from the client's observation counter as each command goes out and again as
     * it settles, the way the light accessory keeps it. A websocket push is stamped when
     * it is received, so it always passes; only a poll that was already in the air when
     * the command was sent falls below - and that is exactly the report whose shape can
     * still match the pending op and confirm it falsely, or rewrite the context with the
     * state the command was sent to leave.
     */
    private readonly staleBefore = new Map<string, number>();
    // Mode switches whose SET/GET handlers are already attached, per device. Services
    // restored from the accessory cache come back without their handlers, and the sync
    // runs on every device event, so both cases have to be told apart.
    private readonly configuredModeSwitches = new Map<string, Set<string>>();
    private readonly gestures = new Map<string, PendingGesture>();
    /** Gestures seen so far, per device, numbering each so a queued one can be overtaken. */
    private readonly gestureSeq = new Map<string, number>();
    /**
     * The newest gesture that carries nothing but a speed, per device.
     *
     * A drag is a run of requests rather than one, and with every command confirmed
     * against a device event before the next, the queue holds several of its steps at
     * once. A speed is one scalar, so a newer speed-only gesture replaces an older one
     * outright - the light accessory's pass-over, borrowed for the one gesture shape it
     * is true of. It is also what keeps a drag that dips through zero from stopping the
     * vent on its way back up. Gestures that carry power or a mode are never passed
     * over: they carry intents a later speed does not restate, and dropping them is how
     * a named mode once went missing (the bug cb7707c fixed).
     */
    private readonly newestSpeedOnlySeq = new Map<string, number>();
    /**
     * How many gathered gestures are being carried out on each device right now.
     *
     * A gesture leaves as several commands, and the device reports the state after each
     * one, so a run that ends at high is reported at low first and only then at high.
     * Every one of those reports is true, and reflecting them as they arrive is what
     * makes the slider visibly jump before it settles. Held back until the last command
     * is answered, the accessory shows the result of the gesture rather than the route
     * it took.
     *
     * A count rather than a flag. Two gestures overlap easily - changing a mode and then
     * reaching for the speed is enough - and the second is queued behind the first rather
     * than replacing it. Sharing one entry, the first to finish would release the hold
     * while the second was still commanding, which is exactly the case this exists for.
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
    private readonly runningGestures = new Map<string, number>();
    private operationTimeoutMilliseconds = VENT_OPERATION_TIMEOUT_MILLISECONDS;

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

    private isHomeKitNameableMode(mode: string | undefined): boolean {
        // Whether `TargetAirPurifierState` can name the mode the vent is on. It carries
        // automatic and manual and nothing else, so bypass, cleaning and anything else
        // chosen in the app are modes it cannot express - and writing to it while one of
        // those is running would replace it with a superficially equivalent value.
        return mode === Mode.MANUAL || mode === Mode.AUTO_DRIVING;
    }

    private deviceMode(value: unknown, fallback: string = Mode.AUTO_DRIVING): string {
        // Whatever the device called it, kept as it came. A push carries only what
        // changed, so a report without `mode` leaves the last one standing rather than
        // meaning the vent has none. The final fallback is automatic driving, which is a
        // guess and is why `modeReported` records that it was one.
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
                this.log.debug("Vent :: %s :: SET :: mode switch %s -> %s",
                    this.getAccessoryInterface(accessory).displayName, mode, value ? "on" : "off");
                this.recordGesture(accessory, (gesture) => {
                    if(value) {
                        gesture.namedMode = mode;
                        gesture.clearedModes.delete(mode);
                        return;
                    }
                    // Only recorded. Clearing the mode the vent runs stops it, because
                    // there is no "no mode" state to fall back to - but only when nothing
                    // else in the gesture named a mode, and a switch that names one may
                    // not have been written yet. `flushGesture()` decides.
                    gesture.clearedModes.add(mode);
                    if(gesture.namedMode === mode) {
                        gesture.namedMode = undefined;
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

    /**
     * The modes the accessory already carries a switch for.
     *
     * Stands in for `getVentModes()` while the supported modes are unknown. A switch only
     * ever exists because a successful read created it, and the accessory cache keeps it
     * across restarts, so its subtype is something the server once said this vent has
     * rather than something guessed here. Reading the modes is a single fetch at sign-in
     * with nothing to fall back on - the WallPad does not answer for which modes a vent
     * supports - so without this a start that failed to read them would leave the
     * switches sitting there doing nothing until the next restart.
     *
     * Safe across devices: the switches hang off one accessory, and the accessory's UUID
     * is derived from the device id, so a switch cached under one vent cannot authorise a
     * command to another.
     */
    private modeSwitchAllowlist(accessory: PlatformAccessory): Set<string> {
        return new Set(this.modeSwitchServices(accessory).map((service) => service.subtype!));
    }

    /**
     * The mode a gesture asks the device for, or `undefined` when it asks for none.
     *
     * Nothing leaves here that the vent has not been said to support. Issue #135 was a
     * vent driven into a beeping, wallpad-locked state by repeated mode commands, which
     * is why `~/hb-testkit/vent-mode-capture.py` reads mode values off the wire instead of
     * guessing them; a command naming a value this vent has no button for is that same
     * guess made at runtime. Where the supported modes cannot be established, this refuses
     * rather than approximating - the behaviour that shipped before the mode switches.
     */
    private resolveWantedMode(accessory: PlatformAccessory, gesture: PendingGesture, baseMode: string): string | undefined {
        const context = this.getAccessoryInterface(accessory);
        // `_client` rather than `client`, which throws before the provider has served.
        const modes = this._client?.getVentModes(context.deviceId);
        const refuse = (wanted: string) => {
            this.log.warn("Not asking %s for the %s mode: the device is not known to support it.",
                context.displayName, wanted);
            return undefined;
        };

        // A mode named by a switch wins over the AUTO/MANUAL toggle. MANUAL names no mode
        // of its own and would otherwise undo the switch pressed in the same gesture, and
        // AUTO reaches here only from a scene that asks for both at once.
        if(gesture.namedMode !== undefined) {
            const named = gesture.namedMode;
            const supported = modes
                ? modes.some((mode) => mode.value === named)
                : this.modeSwitchAllowlist(accessory).has(named);
            return supported ? named : refuse(named);
        }

        if(gesture.autoRequested) {
            if(modes) {
                const auto = modes.find((mode) => this.isAutoDrivingMode(mode));
                // The value rather than the constant: a household could label automatic
                // driving `자동` while calling it something else on the wire.
                return auto ? auto.value : refuse(Mode.AUTO_DRIVING);
            }
            return this.canNameModeBlindly(context, baseMode)
                ? Mode.AUTO_DRIVING
                : refuse(Mode.AUTO_DRIVING);
        }

        if(gesture.manualRequested) {
            // MANUAL only rules automatic out, so a vent already running anything else
            // satisfies it and needs no command at all.
            if(!this.isHomeKitAutomaticMode(baseMode)) {
                return undefined;
            }
            if(modes) {
                const switchable = modes.filter((mode) => !this.isAutoDrivingMode(mode));
                // Plain ventilation is what the app leaves a vent on when it is not
                // driving itself, so it is what "not automatic" settles on where it
                // exists; otherwise the first mode the vent offers besides automatic.
                const plain = switchable.find((mode) => mode.label === PLAIN_VENTILATION_LABEL);
                const chosen = plain || switchable[0];
                return chosen ? chosen.value : refuse(Mode.MANUAL);
            }
            return this.canNameModeBlindly(context, baseMode)
                ? Mode.MANUAL
                : refuse(Mode.MANUAL);
        }

        return undefined;
    }

    /**
     * Whether an AUTO/MANUAL write may be sent as the literal value while the supported
     * modes are unknown. This is the guard that shipped before the mode switches: it
     * preserves a mode HomeKit cannot express instead of replacing it, and it also
     * declines a vent that has never reported a mode, whose `mode` is the automatic
     * driving this class falls back to rather than anything the device said.
     */
    private canNameModeBlindly(context: VentAccessoryInterface, baseMode: string): boolean {
        return context.modeReported && this.isHomeKitNameableMode(baseMode);
    }

    // ---- gestures ------------------------------------------------------------

    /**
     * Gathers one HAP request's writes before anything is decided.
     *
     * hap-nodejs starts every characteristic write of one request without awaiting, and
     * these handlers answer synchronously, so one turn of the event loop is exactly the
     * set of writes that belong together - the `setImmediate` fires with the request
     * whole. Nothing here waits on a clock. The 200ms window this replaces bought the
     * same grouping at the price of a fixed delay, and still missed the companion write
     * that trails a request by more - 2026-07-31 02:04:36 saw one arrive a second late.
     * Late writes become gestures of their own and are read against the device only
     * after the earlier ones have run, which is what makes them harmless.
     */
    private recordGesture(accessory: PlatformAccessory, apply: (gesture: PendingGesture) => void) {
        const context = this.getAccessoryInterface(accessory);
        let gesture = this.gestures.get(context.deviceId);
        if(!gesture) {
            const seq = (this.gestureSeq.get(context.deviceId) || 0) + 1;
            this.gestureSeq.set(context.deviceId, seq);
            gesture = { seq, clearedModes: new Set<string>() };
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
     * hold unbroken from the first write to the last command - dropping it between the
     * two would let the states the device passes through on the way reach the
     * characteristics.
     */
    private async flushGesture(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const gesture = this.gestures.get(context.deviceId);
        if(!gesture) {
            return;
        }
        this.gestures.delete(context.deviceId);
        this.beginGesture(context.deviceId);
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
            this.log.warn("Vent control request failed: %s", error?.message || error);
        } finally {
            // Released before the state is put back, and in a `finally` so a command
            // that threw cannot leave the accessory frozen on a state it has left.
            this.endGesture(context.deviceId);
        }
        // Whatever the device settled on goes back onto the characteristics, which is
        // also what restores a slider the user moved in a mode that has no speed. It
        // does nothing while another gesture on this device is still commanding.
        this.applyAccessoryState(accessory);
    }

    /** Whether the gesture carries nothing but a speed - the one shape a newer speed replaces. */
    private isSpeedOnlyGesture(gesture: PendingGesture): boolean {
        return gesture.speedWrite !== undefined
            && gesture.active === undefined
            && gesture.namedMode === undefined
            && !gesture.autoRequested
            && !gesture.manualRequested
            && gesture.clearedModes.size === 0;
    }

    /**
     * Turns one gesture into commands, in the order the device needs them: power first,
     * because nothing else applies while it is off, then the mode, and the speed last
     * because a mode change resets it.
     *
     * Runs when the device queue gets here, so everything it reads is the device after
     * the gestures queued ahead of it - each of those was answered by a device event
     * before this one's turn came. That is what folds a late write into what came
     * before it instead of replaying the state it happened to be written against; see
     * `PendingGesture` for the field incident this settles.
     */
    private async carryOutGesture(accessory: PlatformAccessory, device: Device, gesture: PendingGesture): Promise<boolean> {
        const context = this.getAccessoryInterface(accessory);
        if(this.isSpeedOnlyGesture(gesture)
            && (this.newestSpeedOnlySeq.get(context.deviceId) || 0) > gesture.seq) {
            // A newer speed-only gesture is already waiting, so this one is a place the
            // finger passed through rather than anywhere it meant to leave the vent.
            this.log.debug("Vent :: %s :: a newer speed is waiting, so %s is passed over",
                context.displayName, String(gesture.speedWrite));
            return true;
        }

        const baseActive = context.active;
        const baseMode = context.mode;
        const baseSpeed = context.rotationSpeed;

        const wantedMode = this.resolveWantedMode(accessory, gesture, baseMode);
        // A mode change resets the speed at the WallPad - measured: a vent at `middle`
        // came back at `low` on nothing but `{mode: cleaning}` - so a gesture that named
        // only a mode still has to say what speed it means, or the choice is lost every
        // time a mode is picked. The speed the vent was running at carries across, and
        // it does not matter who chose it: a change made at the WallPad arrives as a
        // report and is already in the context this reads.
        //
        // Only from a mode that had a speed to begin with, and that is taken from the
        // device having reported one rather than from `isFanSpeedControllableMode()`.
        // That is a denylist of the two modes known to have no speed, so a mode this
        // plugin has never seen is assumed to have one - and for a mode that turns out
        // not to, the context holds the speed remembered from before it, which was never
        // chosen there and must not be carried out of it. The absent `wind_speed` field
        // says so without anything having to be on a list.
        const carriedSpeed = wantedMode !== undefined
            && context.speedReported
            && baseSpeed !== RotationSpeed.OFF
            ? baseSpeed
            : undefined;
        const wantedSpeed = gesture.speedWrite && gesture.speedWrite !== RotationSpeed.OFF
            ? gesture.speedWrite
            : carriedSpeed;
        // What the gesture says about power, once every write it carries is in.
        // An explicit `Active` write and a drag that stopped on zero both say it
        // outright; clearing the mode the vent runs says it only because there is no
        // "no mode" state to fall back into, which a mode named elsewhere in the same
        // gesture answers. Naming a mode or a speed on a stopped vent starts it,
        // which is how the app behaves too.
        const stopRequested = gesture.active === false
            || gesture.speedWrite === RotationSpeed.OFF
            || (wantedMode === undefined && gesture.clearedModes.has(baseMode));
        const wantedActive = !stopRequested
            && (gesture.active === true || baseActive
                || wantedMode !== undefined || wantedSpeed !== undefined);

        this.log.debug("Vent :: %s :: gesture [%s] asks active=%s mode=%s speed=%s (from active=%s mode=%s speed=%s)",
            context.displayName, this.describeGesture(gesture),
            wantedActive ? "on" : "off", wantedMode || "-", wantedSpeed || "-",
            baseActive ? "on" : "off", baseMode, baseSpeed);

        if(!wantedActive) {
            if(this.getAccessoryInterface(accessory).active) {
                await this.sendDeviceStateAndWait({...device, op: {control: "off"}});
            }
            return true;
        }
        if(!this.getAccessoryInterface(accessory).active) {
            const accepted = await this.sendDeviceStateAndWait({
                ...device,
                op: this.onSetActivityOp(true, {control: "on"}),
            });
            if(!accepted) return false;
        }
        if(wantedMode && this.getAccessoryInterface(accessory).mode !== wantedMode) {
            const accepted = await this.sendDeviceStateAndWait({...device, op: {mode: wantedMode}});
            if(!accepted) return false;
        }
        const current = this.getAccessoryInterface(accessory);
        if(wantedSpeed && this.isFanSpeedControllableMode(current.mode)
            && current.rotationSpeed !== wantedSpeed) {
            await this.sendDeviceStateAndWait({
                ...device,
                op: {wind_speed: wantedSpeed.toString()},
            });
        }
        return true;
    }

    /** One line saying what the gesture carried, for the log. */
    private describeGesture(gesture: PendingGesture): string {
        const writes = [];
        if(gesture.active !== undefined) writes.push(`active=${gesture.active ? "on" : "off"}`);
        if(gesture.namedMode !== undefined) writes.push(`mode=${gesture.namedMode}`);
        if(gesture.clearedModes.size > 0) writes.push(`cleared=${[...gesture.clearedModes].join("+")}`);
        if(gesture.autoRequested) writes.push("AUTO");
        if(gesture.manualRequested) writes.push("MANUAL");
        if(gesture.speedWrite !== undefined) writes.push(`speed=${gesture.speedWrite}`);
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
        // leaves. On 2026-07-31 the control endpoint took 3..7 seconds per call, so a
        // clock started at send time was spent before the device had been asked at all -
        // the waiter is still installed before the request, because the event can
        // outrun the HTTP response, but the deadline only makes sense from acceptance.
        const arm = () => {
            if(completed || timer) return;
            timer = setTimeout(() => {
                this.log.warn("Vent operation was not confirmed by a device event: %s", JSON.stringify(operation));
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
     * Sends one op and waits for a device event to answer it.
     *
     * Resolves false only when the server refused the command outright; a network
     * failure still throws. A confirmation that never arrives resolves true once the
     * budget runs out, because unconfirmed is not failed: every op that went
     * unconfirmed in the 2026-07-31 field log had in fact been applied - the event was
     * late, not absent - and reading the silence as failure is what dropped the rest of
     * the gesture there, leaving the vent running plain ventilation instead of the mode
     * that was asked for.
     */
    private async sendDeviceStateAndWait(device: DeviceWithOp): Promise<boolean> {
        if(this.operationMatchesContext(device.deviceId, device.op)) {
            this.log.debug("Vent :: %s :: %s is already satisfied", device.displayName, JSON.stringify(device.op));
            return true;
        }

        // Install the waiter before the HTTP request so a fast websocket event cannot
        // arrive between request acceptance and confirmation registration.
        const confirmation = this.createDeviceConfirmation(device.deviceId, device.op);
        // Anything observed before now was observed before this command existed.
        this.staleBefore.set(device.deviceId, this.client.takeObservedSeq());
        const sentAt = Date.now();
        try {
            const accepted = await super.setDeviceState(device);
            if(!accepted) {
                confirmation.cancel();
                return false;
            }
            confirmation.arm();
            const confirmed = await confirmation.promise;
            if(confirmed) {
                this.log.debug("Vent :: %s :: %s confirmed in %dms",
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
                this.log.debug("Vent :: %s :: SET :: Active -> %s",
                    this.getAccessoryInterface(accessory).displayName, active ? "on" : "off");
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
                this.log.debug("Vent :: %s :: SET :: TargetAirPurifierState -> %s",
                    this.getAccessoryInterface(accessory).displayName,
                    value === this.api.hap.Characteristic.TargetAirPurifierState.AUTO ? "AUTO" : "MANUAL");
                this.recordGesture(accessory, (gesture) => {
                    // Recorded as which of the two was asked for rather than as a mode.
                    // AUTO names automatic driving but not the value this vent calls it
                    // by, and MANUAL names no mode at all - it only rules automatic out.
                    // `resolveWantedMode()` turns either into a value the device supports.
                    if(value === this.api.hap.Characteristic.TargetAirPurifierState.AUTO) {
                        gesture.autoRequested = true;
                        gesture.manualRequested = false;
                        return;
                    }
                    gesture.manualRequested = true;
                    gesture.autoRequested = false;
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
                this.log.debug("Vent :: %s :: SET :: RotationSpeed %s -> %s",
                    this.getAccessoryInterface(accessory).displayName, numeric.toFixed(2), newSpeed.toString());
                this.recordGesture(accessory, (gesture) => {
                    // Only recorded, zero included. Zero is HomeKit's way of stopping a
                    // fan rather than a speed, and it stops the vent even where a speed
                    // cannot be chosen - which is how the slider behaves on the air
                    // conditioner too - but only when the drag ended there. What decides
                    // that is which write came last, so the answer waits for the gesture.
                    gesture.speedWrite = newSpeed;
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

        this.addDeviceListener((devices, metadata) => {
            for(const device of devices) {
                const staleBefore = this.staleBefore.get(device.deviceId);
                if(staleBefore !== undefined && metadata.observedSeq < staleBefore) {
                    // Dropped before it touches anything. Applied, it would rewrite the
                    // context with the state the command in flight was sent to leave -
                    // and its shape can even match the pending op, confirming a command
                    // the device has not answered. The vent is polled every thirty
                    // seconds, so a poll straddling a command is a matter of time.
                    this.log.debug("Vent :: %s :: ignoring a report observed before the command in flight",
                        device.displayName);
                    continue;
                }
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
                // A push carries only what changed, so a report without `mode` says
                // nothing either way and what was learned before stands.
                const modeReported = (typeof device.op["mode"] === "string" && device.op["mode"].length > 0)
                    || !!cachedContext?.modeReported;
                // The device's own account of whether this mode has a speed to choose. A mode
                // without one omits the field, which is the only signal that covers a mode
                // `isFanSpeedControllableMode()` has never heard of.
                const speedReported = typeof device.op["wind_speed"] === "string"
                    && device.op["wind_speed"].length > 0;
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
                    modeReported,
                    speedReported,
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
