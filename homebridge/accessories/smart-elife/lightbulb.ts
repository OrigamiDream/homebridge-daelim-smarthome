import {
    API, CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback, CharacteristicValue, Logging, PlatformAccessory
} from "homebridge";
import {Device, DeviceType, LightbulbGroup, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {Utils} from "../../../core/utils";
import {OnOffAccessories, OnOffAccessoryInterface} from "./on-off-accessories";
import {DeviceWithOp} from "./accessories";
import {ListenerMetadata} from "../../../core/smart-elife/smart-elife-client";
import {
    MIRED_MAX_VALUE, MIRED_MIN_VALUE, hardwareToMiredColorTemperature,
    miredToHardwareColorTemperature, parseLightbulbValue,
} from "../../../core/smart-elife/lightbulb-value";

/**
 * Live state of a merged room, held on the accessory's context.
 * Which lights belong to it is not decided here - the settings wizard resolved that
 * and wrote it into the configuration.
 */
interface LightbulbLevelState {
    /** Canonical room name from the WallPad, e.g. `침실1`. */
    room: string

    /** Device ids ordered from the lowest level flag to the highest. */
    members: string[]

    /**
     * On/off of each member as the WallPad last reported it, parallel to {@link members}.
     * Only what comes back from the room is written here.
     */
    flags: boolean[]

    /**
     * What an outstanding command asked those flags to become, and nothing else.
     * Absent once an authoritative report has spoken.
     *
     * Kept apart from {@link flags} because a report and a command mean different things:
     * reports say where the room is, commands say where it was asked to go,
     * and a command that comes to nothing drops its answer rather than leaving it as history.
     */
    intended?: boolean[]

    /**
     * Level the room returns to when it is asked for light without being told how much.
     * Kept apart from the level the room is at, because the two disagree exactly where it
     * matters: a gesture the room could only answer by going dark still has to leave the
     * level it asked for on the slider of the unlit room.
     */
    remembered?: number
}

interface LightbulbAccessoryInterface extends OnOffAccessoryInterface {
    prefix: string
    brightness: number
    brightnessAdjustable: boolean

    /**
     * HomeKit/Home app value (mired), e.g. 140..500.
     */
    colorTemperature: number

    /**
     * Hardware/native value, e.g. 0..100.
     */
    colorTemperatureHw: number

    colorTemperatureAdjustable: boolean

    /**
     * Set only on the merged room accessory. Its absence marks a plain per-device light.
     */
    levels?: LightbulbLevelState
}

/** What a gesture asked for, and what the room can actually answer with. */
interface LightbulbTarget {
    requested: number
    effective: number
}

/** The characteristic writes of one HAP request, collected before a command is sent. */
interface LightbulbGesture {
    /** Level the room was headed for when the gesture began. */
    baseLevel: number

    /**
     * Where this gesture sits in the order they arrived.
     * A drag is a run of requests rather than one, so by the time an early one reaches the
     * front of the queue the finger has usually moved past it - see {@link LightbulbAccessories.applyLevel}.
     */
    seq: number

    power?: boolean
    level?: number
}

/** Keeps a merged accessory's synthetic id from colliding with a real `uid`. */
const LEVEL_GROUP_DEVICE_ID_PREFIX = "lightbulbs:";

/**
 * How many whole reports may disagree with an outstanding command
 * before the room is believed over it.
 *
 * The WallPad answers a control request in about 200ms and then acts on it in its own time,
 * switching one light at a time and reporting each. So the reports following a command
 * describe, in order: the room before the command took effect, then the room part way
 * through it, and only then the room the command asked for. Publishing each of those in turn
 * walks the tile back to where it started before it arrives where it was sent - which is what
 * a resident sees as the slider snapping back to its old value and then moving on.
 *
 * What has to be tolerated is the length of that procession, and the group's own size fixes it:
 * one report for the command not yet applied, one for each light that switches on the way
 * (`members.length - 1`, since the last one is the arrival itself), and one spare.
 *
 * Measured against the household this was written for - 침실1, two lights:
 *
 *   100 -> 0    reported level 2 (not yet applied), then level 1 (mid-change), then level 0
 *   50  -> 100  reported level 1 (mid-change), then level 2
 *
 * Two disagreements at worst, which is `members.length`; the spare makes three.
 *
 * Erring long is the safe direction. The cap is only reached where the WallPad accepted a
 * command and then never carried it out, and until then the tile shows what the resident just
 * asked for - a better thing to be showing than the state they asked it to leave.
 * A counter rather than a deadline, so that nothing here waits on a clock.
 */
function disagreementsTolerated(members: number): number {
    return members + 1;
}

export default class LightbulbAccessories extends OnOffAccessories<LightbulbAccessoryInterface> {
    /**
     * Reports observed before this number cannot describe the command that set it.
     *
     * One integer per merged accessory, in place of the guards and echo windows that used to
     * stand for the same thing. A command draws a number when it goes out and another when it
     * comes back, from the same counter the client stamps observations with, so "this report
     * predates my command" is a comparison rather than an interval to wait out.
     */
    private readonly staleBefore: Record<string, number> = {};

    /** Writes of the HAP request currently being collected, per accessory. */
    private readonly gestures: Record<string, LightbulbGesture> = {};

    /** Gestures seen so far, per accessory, so a queued one can tell it has been overtaken. */
    private readonly gestureSeq: Record<string, number> = {};

    /** Runs one accessory's commands one at a time. */
    private readonly operationQueues: Record<string, Promise<void>> = {};

    /** Level the WallPad last reported, per accessory, to tell a rise from a collapse. */
    private readonly reportedLevels: Record<string, number> = {};

    /**
     * Whole reports that have disagreed with the outstanding command so far.
     * Reset when a command is sent and when the room catches up with one.
     * See {@link disagreementsTolerated}.
     */
    private readonly disagreements: Record<string, number> = {};

    /** Rooms already reported as looking like independent circuits. */
    private readonly reportedIndependentCircuits = new Set<string>();

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.LIGHT, [api.hap.Service.Lightbulb], api.hap.Service.Lightbulb);
    }

    protected handlesOnOff(accessory: PlatformAccessory): boolean {
        return !this.getAccessoryInterface(accessory).levels;
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        if(this.getAccessoryInterface(accessory).levels) {
            // The inherited handler blinks the single device the context names, and a merged
            // accessory is named by a synthetic id no device answers to. Blinking the group
            // instead would mean darkening the room and lighting it again, which is the
            // blackout this design refuses everywhere else.
            this.log.info("%s stands for several lights, so identifying it does nothing.",
                accessory.displayName);
            return;
        }
        await super.identify(accessory);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        const context = this.getAccessoryInterface(accessory);

        if(context.levels) {
            this.configureGroupAccessory(accessory);
            return;
        }
        if(context.brightnessAdjustable) {
            this.getService(accessory, this.api.hap.Service.Lightbulb)
                .getCharacteristic(this.api.hap.Characteristic.Brightness)
                .setProps({
                    format: this.api.hap.Formats.UINT16,
                    minValue: 0,
                    maxValue: 100,
                    minStep: 1,
                })
                .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    const brightness = value as number;
                    if(context.brightness === brightness) {
                        callback(undefined);
                        return;
                    }
                    const device = this.findDevice(context.deviceId);
                    if(!device) {
                        callback(new Error(`Unknown device: ${context.deviceId}`));
                        return;
                    }
                    context.brightness = brightness;

                    this.defer(device.deviceId, this.setDeviceState({
                        ...device, op: {
                            value: this.createLightbulbValue(context),
                        },
                    }));

                    callback(undefined);
                })
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    callback(undefined, context.brightness);
                });
        }
        if(context.colorTemperatureAdjustable) {
            this.getService(accessory, this.api.hap.Service.Lightbulb)
                .getCharacteristic(this.api.hap.Characteristic.ColorTemperature)
                .setProps({
                    // HomeKit ColorTemperature is an integer mired value.
                    format: this.api.hap.Formats.UINT16,
                    minValue: MIRED_MIN_VALUE,
                    maxValue: MIRED_MAX_VALUE,
                    minStep: 1,
                })
                .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    const mired = value as number;

                    const device = this.findDevice(context.deviceId);
                    if(!device) {
                        callback(new Error(`Unknown device: ${context.deviceId}`));
                        return;
                    }

                    // Convert 140..500 (HomeKit) -> 0..100 (hardware), quantize to integer step.
                    const hw = miredToHardwareColorTemperature(mired, MIRED_MIN_VALUE, MIRED_MAX_VALUE);
                    this.log.debug(`Lightbulb :: SET :: Color temperature: ${mired} (HomeKit) -> ${hw} (Hardware)`);
                    if(context.colorTemperatureHw === hw) {
                        callback(undefined);
                        return;
                    }

                    // Store BOTH values to keep GET / polling consistent and avoid drift.
                    context.colorTemperatureHw = hw;
                    context.colorTemperature = hardwareToMiredColorTemperature(hw, MIRED_MIN_VALUE, MIRED_MAX_VALUE);
                    this.log.debug(`Lightbulb :: SET :: Color temperature: ${hw} (Hardware) -> ${context.colorTemperature} (HomeKit)`);

                    this.defer(device.deviceId, this.setDeviceState({
                        ...device,
                        op: {
                            value: this.createLightbulbValue(context),
                        },
                    }));

                    callback(undefined);
                })
                .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                    const context = this.getAccessoryInterface(accessory);
                    callback(undefined, context.colorTemperature);
                });
        }
    }

    private configureGroupAccessory(accessory: PlatformAccessory) {
        const service = this.getService(accessory, this.api.hap.Service.Lightbulb);

        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                this.queueLevel(accessory, { power: !!value });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getAccessoryInterface(accessory).on);
            });

        service.getCharacteristic(this.api.hap.Characteristic.Brightness)
            .setProps({
                // Declare the whole percentage range rather than the room's levels.
                // Snapping the slider to the levels destroyed the one thing worth reading from
                // a tap near the bottom of it: in a room of two lights a tap at 10% was written
                // as a plain zero, indistinguishable from being switched off, so the brightness
                // had to be guessed at while the Home app filled the tile to full waiting to be
                // told otherwise. At one percent the write carries where the finger was, and
                // rounding it to a level the room can hold is ours to do.
                //
                // A step dividing the range unevenly also put the top of it out of reach:
                // hap-nodejs lowers `maxValue` to the last whole step, which for three levels
                // left the slider ending at 99.99999 rather than at full brightness.
                format: this.api.hap.Formats.UINT16,
                minValue: 0,
                maxValue: 100,
                minStep: 1,
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const brightness = value as number;
                // Read the group as it stands rather than as it was when the handler was
                // registered. A cached accessory keeps its handlers across a restart while its
                // context is replaced, so a room that lost a light would still be dividing the
                // slider by the old count - and half of three is not half of two.
                const current = this.getAccessoryInterface(accessory).levels!;
                this.queueLevel(accessory, {
                    level: this.levelOfBrightness(brightness, current.members.length),
                    brightness,
                });
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.getAccessoryInterface(accessory).brightness);
            });
    }

    private levelOfFlags(flags: boolean[]): number {
        return flags.filter(flag => flag).length;
    }

    /** Where the WallPad last said the room was. */
    private confirmedLevel(levels: LightbulbLevelState): number {
        return this.levelOfFlags(levels.flags);
    }

    /**
     * Where the room is headed: what an outstanding command asked for while it is outstanding,
     * and what the WallPad last reported otherwise. This is what a command has to be judged
     * against - a second command queued behind the first must see where the first is taking
     * the room.
     */
    private plannedLevel(levels: LightbulbLevelState): number {
        return this.levelOfFlags(levels.intended || levels.flags);
    }

    /**
     * The level a brightness stands for.
     * Only a brightness of zero leaves the room off: hap-nodejs rounds what an accessory
     * publishes to `minStep` but lets a controller write whatever it likes, so the Home app is
     * free to send a percentage between the steps - and rounding a small one down to nothing
     * would darken a room asked to be dimly lit.
     */
    private levelOfBrightness(brightness: number, members: number): number {
        if(brightness <= 0) {
            return 0;
        }
        const level = Math.round((brightness * members) / 100);
        return Math.min(members, Math.max(1, level));
    }

    /** True while the flags form an `on…on off…off` run, the only shape the level produces. */
    private isValidLevelState(flags: boolean[]): boolean {
        let seenOff = false;
        for(const flag of flags) {
            if(!flag) {
                seenOff = true;
            } else if(seenOff) {
                return false;
            }
        }
        return true;
    }

    /**
     * Collects the characteristic writes of one HAP request before acting on them.
     *
     * Turning a dark room on at half brightness arrives as `On` *and* `Brightness` together,
     * and acting on each in turn would read the second as a step down from the level the first
     * just set - which powers the room off again. hap-nodejs starts every write of one request
     * without awaiting, and these handlers answer synchronously, so one turn of the event loop
     * is exactly the set of writes that belong together. Nothing here waits on a clock.
     */
    private queueLevel(accessory: PlatformAccessory, patch: {
        power?: boolean,
        level?: number,

        /**
         * The brightness the controller wrote, carried for the log alone.
         * hap-nodejs rounds what an accessory publishes to `minStep` but leaves a controller's
         * writes as they came, so this is the only place that shows whether the Home app keeps
         * to the step.
         */
        brightness?: number,
    }) {
        const context = this.getAccessoryInterface(accessory);
        const key = context.deviceId;

        let gesture = this.gestures[key];
        if(!gesture) {
            const seq = (this.gestureSeq[key] || 0) + 1;
            this.gestureSeq[key] = seq;
            gesture = { baseLevel: this.plannedLevel(context.levels!), seq };
            this.gestures[key] = gesture;
            // One turn later the request is whole. Everything that has to happen in order -
            // saying where the room is going, then asking it to go - happens here, so that
            // nothing scheduled separately can land after the command has already resolved
            // and put the tile back to a guess the command has since corrected.
            setImmediate(() => {
                const collected = this.gestures[key];
                delete this.gestures[key];
                if(!collected) {
                    return;
                }
                // Say where the gesture is heading before the command goes out. HomeKit paints
                // its own guess otherwise - a room it has just switched on shows as fully lit -
                // and this is the first moment it can be contradicted: `handleSetRequest` stamps
                // the value the controller wrote once the handler has returned.
                const heading = this.resolveTarget(context, collected, collected.baseLevel);
                if(heading.effective !== collected.baseLevel) {
                    this.publishLevel(accessory, heading.effective);
                }
                this.enqueueOperation(key, () => this.applyLevel(accessory, collected));
            });
        }
        if(patch.power !== undefined) {
            gesture.power = patch.power;
        }
        if(patch.level !== undefined) {
            gesture.level = patch.level;
        }
        this.log.debug("Lightbulb :: %s :: collected power=%s brightness=%s level=%s (from level %d)",
            context.displayName, String(patch.power), String(patch.brightness),
            String(patch.level), gesture.baseLevel);
    }

    /**
     * What the gesture is asking the room to become.
     * Powering on with no brightness of its own returns to the level the room was last lit at,
     * which is the one HomeKit shows on the slider of a dark room; landing on the top level
     * instead would contradict what the user was just looking at.
     */
    private resolveTarget(context: LightbulbAccessoryInterface, gesture: LightbulbGesture,
                         base: number): LightbulbTarget {
        const remembered = this.rememberedLevel(context);
        // An explicit off wins over anything else the gesture carried, whenever in the gesture
        // it arrived. Deciding by arrival order instead reads a scene that sets `On=false`
        // beside a brightness as a request to light the room, because the handlers run in
        // whichever order HomeKit happens to call them.
        let requested: number;
        if(gesture.power === false) {
            requested = 0;
        } else if(gesture.level === undefined) {
            requested = gesture.power === true ? remembered : base;
        } else if(gesture.level === 0 && gesture.power === true) {
            // A zero arriving with `On` names no level at all. The Home app snaps a tap near the
            // bottom of the slider down to zero and sends `On` with it, so reading that zero as a
            // level of its own contradicted the value the app was displaying - the room came on
            // at the remembered level and then fell to the dimmest step.
            requested = remembered;
        } else {
            requested = gesture.level;
        }
        // Switching any flag off drops the room to level 0, so the WallPad offers no way to step
        // down. Asking for a lower level therefore leaves the room where it is: taking it all the
        // way to dark would be doing something nobody asked for, and darkening it only to light
        // it again is the blackout this design was turned down for.
        //
        // Asking for darkness outright is untouched - that arrives as a zero, not as a lower
        // level - so the slider's bottom and the tile still switch the room off.
        const refused = requested > 0 && requested < base;
        return { requested, effective: refused ? base : requested };
    }

    /**
     * Level the room lights at when it is asked for light without being told how much.
     * Never zero: a room with nothing recorded yet takes its dimmest step, so a tap on a dark
     * tile errs towards too little light rather than too much.
     */
    private rememberedLevel(context: LightbulbAccessoryInterface): number {
        const remembered = context.levels!.remembered;
        return remembered !== undefined && remembered > 0 ? remembered : 1;
    }

    private async applyLevel(accessory: PlatformAccessory, gesture: LightbulbGesture): Promise<void> {
        const context = this.getAccessoryInterface(accessory);
        const levels = context.levels;
        if(!levels) {
            return; // the group was replaced while this waited its turn
        }
        const key = context.deviceId;

        // A newer gesture is already waiting, so this one is a place the finger passed through
        // rather than anywhere it meant to leave the room.
        //
        // A drag is not one request but a run of them, and each carries the brightness the
        // finger was at. Acting on every one takes the room through every level on the way -
        // dragging a dark room to full switched one light on and then both, and the tile
        // followed. Worse, the room really did sit at the middle level for a moment, so it was
        // learned as the level a switch-on should return to, which is why the slider of the
        // dark room afterwards sat at half rather than where it had been left.
        //
        // The queue already puts these in order; this is only asking whether anything newer is
        // behind us. Nothing is timed - a slow, deliberate drag has no successor waiting when
        // its turn comes, and every step of it is still commanded.
        if(gesture.seq < (this.gestureSeq[key] || 0)) {
            this.log.debug("Lightbulb :: %s :: a newer gesture is waiting, so level %s is passed over",
                context.displayName, String(gesture.level));
            return;
        }

        // Judge against where the room is now, not where the gesture found it. A command waits
        // for whatever the queue is already carrying, and an earlier command may have raised the
        // level in between - deciding a step down against the older figure would send an `on`
        // the room ignores, and then report a level it never reached.
        const currentLevel = this.plannedLevel(levels);
        const target = this.resolveTarget(context, gesture, currentLevel);
        if(target.effective === currentLevel) {
            // The gesture resolved to where the room is already headed, so no command goes out
            // and whatever HomeKit is showing has to be put right. Immediately: the handle stays
            // under the finger through a drag and only the figure beside it flickers, and the
            // last write of a gesture resolves the same way, so the final value is the right one.
            this.publishLevel(accessory, currentLevel);
            return;
        }
        const effective = target.effective;
        const deviceIds = effective === 0 ? levels.members : levels.members.slice(0, effective);
        const control = effective === 0 ? "off" : "on";
        this.log.debug("Lightbulb :: %s :: level %d -> %d (asked %d, gesture began at %d), sending %s to %s",
            context.displayName, currentLevel, effective, target.requested, gesture.baseLevel,
            control, deviceIds.join(","));

        // Anything observed before now was observed before this command existed.
        this.staleBefore[key] = this.client.takeObservedSeq();

        // Say where the room is going before asking it to go. Written as intent, beside what the
        // WallPad last said rather than over it, so a command that comes to nothing takes its
        // answer back with it.
        levels.intended = levels.members.map((_, index) => index < effective);
        delete this.disagreements[key];
        this.publishLevel(accessory, effective);

        const sentAt = Date.now();
        let success = false;
        try {
            success = await this.client.sendDeviceControlAll(DeviceType.LIGHT, deviceIds, control);
        } catch(error: any) {
            // The client throws for a spent retry ladder, an unparseable body and a network error
            // alike, and the queue this runs on swallows what it throws.
            this.log.warn("Could not set %s to level %d: %s",
                context.displayName, effective, error?.message || error);
        }
        this.log.debug("Lightbulb :: %s :: round trip %dms", context.displayName, Date.now() - sentAt);

        // A report requested before the command settled cannot describe its outcome either -
        // the WallPad may not have applied it when that page was asked for.
        this.staleBefore[key] = this.client.takeObservedSeq();
        if(!success) {
            // The intent is gone, so the tile goes back to what the WallPad last said.
            delete levels.intended;
            delete this.disagreements[key];
            this.publishReported(accessory);
        }
        // Believed, and then checked - by asking outright rather than by trusting whatever
        // happened to arrive while the command was in the air.
        void this.client.requestDeviceStatus([DeviceType.LIGHT]);
    }

    /**
     * Runs one accessory's commands one at a time.
     * Two gestures arriving close together would otherwise both read `levels.flags` while the
     * other was halfway through rewriting them, and the second would compare against a base
     * level that no longer holds.
     */
    private enqueueOperation(key: string, operation: () => Promise<unknown>) {
        const queued = (this.operationQueues[key] || Promise.resolve()).then(operation, operation);
        const tail = queued.then(() => undefined, () => undefined);
        this.operationQueues[key] = tail;
        void tail.then(() => {
            // Do not remove a newer operation which was chained behind this one in the meantime.
            if(this.operationQueues[key] === tail) {
                delete this.operationQueues[key];
            }
        });
    }

    /** Reflects what the WallPad reported, and learns from it. */
    private publishReported(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const levels = context.levels!;
        const key = context.deviceId;
        const valid = this.isValidLevelState(levels.flags);

        if(!valid && !this.reportedIndependentCircuits.has(key)) {
            // Said once per room rather than on every report. Reporting the count regardless
            // keeps a household whose lights really are independent circuits working, instead of
            // freezing on a state this refuses to show.
            this.reportedIndependentCircuits.add(key);
            this.log.warn("The lights of %s reported a state the level sequence cannot produce (%s). " +
                "They may be independent circuits rather than levels.",
                levels.room, levels.flags.map(flag => flag ? "on" : "off").join(", "));
        }

        const level = this.confirmedLevel(levels);
        this.reportedLevels[key] = level;
        // Record a lit level whoever lit it - the WallPad and the phone app move these lights
        // too - but only from a shape the sequence can actually produce.
        if(level > 0 && valid) {
            levels.remembered = level;
        }
        this.publishLevel(accessory, level);
    }

    private publishLevel(accessory: PlatformAccessory, level: number) {
        const context = this.getAccessoryInterface(accessory);
        const levels = context.levels!;
        context.on = level > 0;
        // A dark room reports the level a switch-on would return it to rather than a zero, so
        // that the slider of an unlit tile sits where lighting it would put it.
        const shown = level > 0 ? level : this.rememberedLevel(context);
        context.brightness = Math.round((shown * 100) / levels.members.length);

        const service = accessory.getService(this.api.hap.Service.Lightbulb);

        // Say so only where something will actually go out. hap-nodejs drops an update that
        // matches what the characteristic already holds, and a room nobody has touched is
        // republished on every poll.
        const reportedBrightness = service?.getCharacteristic(this.api.hap.Characteristic.Brightness).value;
        const reportedOn = service?.getCharacteristic(this.api.hap.Characteristic.On).value;
        if(reportedBrightness !== context.brightness || reportedOn !== context.on) {
            this.log.debug("Lightbulb :: %s :: reporting brightness %s then %s",
                context.displayName, String(context.brightness), context.on ? "on" : "off");
        }

        // Brightness first. A room reported as on before its level is known is drawn at the top
        // of the range until the level catches up, which is seen as a jump to full brightness
        // and back down again.
        service?.updateCharacteristic(this.api.hap.Characteristic.Brightness, context.brightness);
        service?.updateCharacteristic(this.api.hap.Characteristic.On, context.on);
    }

    private createLightbulbValue(context: LightbulbAccessoryInterface): string {
        const brightness = Utils.addPadding(context.brightness, 3);
        // The device expects the hardware/native range (0..100).
        const colorTemperature = Utils.addPadding(context.colorTemperatureHw, 3);
        return `${context.prefix}_${colorTemperature}_${brightness}`;
    }

    private findGroupAccessory(deviceId: string): PlatformAccessory | undefined {
        for(const accessory of this.accessories) {
            const levels = this.getAccessoryInterface(accessory).levels;
            if(levels && levels.members.indexOf(deviceId) >= 0) {
                return accessory;
            }
        }
        return undefined;
    }

    /**
     * Creates the merged accessories the configuration asks for, and retires whatever a
     * previous configuration left behind. Runs once, at registration.
     *
     * Which lights form a group is not worked out here. The settings wizard resolved it from
     * the device list it fetched and wrote the answer down, so this reads a decision rather
     * than making one - and the set of accessories no longer depends on which page happened
     * to arrive.
     */
    private buildConfiguredAccessories() {
        const groupedMembers = new Set<string>();
        const wanted = new Set<string>();

        for(const anchor of this.configuredLights()) {
            const group = anchor.lightbulbGroup;
            if(anchor.combineLightbulbGroup !== true || !group || group.members.length < 2) {
                continue;
            }
            // The wizard resolved this against the household it saw. Between then and now the
            // resident may have disabled one of the lights, which takes its step with it and
            // leaves a sequence the room does not have.
            const missing = group.members
                .map((deviceId) => ({ deviceId, device: this.findDevice(deviceId) }))
                .filter((member) => !member.device || member.device.disabled);
            if(missing.length > 0) {
                this.log.info("Not merging the lights of %s: %s is disabled or no longer configured. " +
                    "Showing them one accessory each.",
                    group.room, missing.map((member) => member.device?.displayName || member.deviceId).join(", "));
                continue;
            }
            group.members.forEach((deviceId) => groupedMembers.add(deviceId));
            wanted.add(this.addGroupAccessory(anchor, group));
        }

        for(const device of this.configuredLights()) {
            if(!groupedMembers.has(device.deviceId)) {
                wanted.add(device.deviceId);
            }
        }

        // Retire what a previous configuration left in the accessory cache - the per-light
        // accessories a group replaces, or a merged one whose opt-in has since been turned off.
        // Homebridge restores those before this runs, and leaving them behind would show the
        // same lights twice.
        const stale = this.accessories.filter((accessory) =>
            !wanted.has(this.getAccessoryInterface(accessory).deviceId));
        for(const accessory of stale) {
            this.log.info("Retiring light accessory: %s (the configuration no longer asks for it)",
                accessory.displayName);
            this.api.unregisterPlatformAccessories(Utils.PLUGIN_NAME, Utils.PLATFORM_NAME, [accessory]);
            const index = this.accessories.indexOf(accessory);
            if(index >= 0) {
                this.accessories.splice(index, 1);
            }
        }
    }

    private addGroupAccessory(anchor: Device, group: LightbulbGroup): string {
        const identity = `${LEVEL_GROUP_DEVICE_ID_PREFIX}${anchor.deviceId}`;
        // A lit room speaks for itself once the first report lands. What it was remembered at
        // before a restart stands until then - the context is replaced wholesale on the way in,
        // and letting that reset the memory meant a room used at full came back on at its dimmest.
        const cached = this.findAccessory(identity);
        const carried = cached ? this.getAccessoryInterface(cached).levels?.remembered : undefined;
        const remembered = Math.min(group.members.length, Math.max(1, carried || 1));
        this.addOrGetAccessory({
            deviceId: identity,
            uuidSeed: identity,
            deviceType: DeviceType.LIGHT,
            displayName: group.displayName,
            init: true,
            on: false,
            prefix: "light",
            brightness: Math.round((remembered * 100) / group.members.length),
            brightnessAdjustable: true,
            colorTemperature: MIRED_MIN_VALUE,
            colorTemperatureHw: 999,
            colorTemperatureAdjustable: false,
            levels: {
                room: group.room,
                members: [...group.members],
                flags: group.members.map(() => false),
                remembered,
            },
        });
        return identity;
    }

    private configuredLights(): Device[] {
        return (this.config.devices || [])
            .filter((device) => device.deviceType === DeviceType.LIGHT && !device.disabled);
    }

    private syncAccessory(device: DeviceWithOp) {
        const values = parseLightbulbValue(device.op["value"]);
        const accessory = this.addOrGetAccessory({
            deviceId: device.deviceId,
            deviceType: device.deviceType,
            displayName: device.displayName,
            init: true,
            on: device.op["status"] === "on",
            ...values,
        });
        if(!accessory) {
            return;
        }
        const context = this.getAccessoryInterface(accessory);
        const service = accessory.getService(this.api.hap.Service.Lightbulb);
        service?.updateCharacteristic(this.api.hap.Characteristic.On, context.on);
        if(context.brightnessAdjustable)
            service?.updateCharacteristic(this.api.hap.Characteristic.Brightness, context.brightness);
        if(context.colorTemperatureAdjustable)
            service?.updateCharacteristic(this.api.hap.Characteristic.ColorTemperature, context.colorTemperature);
    }

    /**
     * Folds a report into a merged room.
     *
     * Whether it may be believed is a comparison, not a wait: anything observed before the
     * outstanding command was sent describes the room the command was about to leave.
     * Whether it may be *published* turns on whether it is whole - the WallPad reports one
     * device per push, and a room half way through a change is a room HomeKit would otherwise
     * be walked through.
     */
    private applyReport(accessory: PlatformAccessory, updates: { index: number, on: boolean }[],
                        metadata: ListenerMetadata) {
        const context = this.getAccessoryInterface(accessory);
        const levels = context.levels!;
        const key = context.deviceId;

        const staleBefore = this.staleBefore[key];
        if(staleBefore !== undefined && metadata.observedSeq < staleBefore) {
            this.log.debug("Lightbulb :: %s :: ignoring a report observed before the command in flight",
                context.displayName);
            return;
        }
        for(const update of updates) {
            levels.flags[update.index] = update.on;
        }

        // A command is outstanding, and the WallPad has not necessarily acted on it yet.
        // Its own reports arrive describing the room before the command, then part way
        // through it, and only then where it was sent - so until one of them agrees with what
        // was asked for, what was asked for is the better thing to be showing.
        // See `disagreementsTolerated` for how long that patience lasts and why.
        if(levels.intended) {
            const intended = levels.intended;
            if(levels.flags.every((flag, index) => flag === intended[index])) {
                delete levels.intended;
                delete this.disagreements[key];
                this.publishReported(accessory);
                return;
            }
            const seen = (this.disagreements[key] || 0) + 1;
            this.disagreements[key] = seen;
            if(seen <= disagreementsTolerated(levels.members.length)) {
                this.log.debug("Lightbulb :: %s :: the room has not caught up with the command yet " +
                    "(%d of %d), asking again", context.displayName, seen,
                    disagreementsTolerated(levels.members.length));
                void this.client.requestDeviceStatus([DeviceType.LIGHT]);
                return;
            }
            // The WallPad took the command and never carried it out. Believe the room.
            this.log.warn("%s did not reach the level it was set to; showing what the WallPad reports.",
                context.displayName);
            delete levels.intended;
            delete this.disagreements[key];
            this.publishReported(accessory);
            return;
        }

        if(metadata.completeSnapshot) {
            this.publishReported(accessory);
            return;
        }

        // A single device changed. Publishing from that alone is safe only where the flags still
        // form a shape the sequence can produce *and* the room has not appeared to fall - it
        // cannot step down, so a lower level part way through a push burst is a collapse being
        // reported one light at a time, not somewhere the room has settled.
        const level = this.levelOfFlags(levels.flags);
        const previous = this.reportedLevels[key];
        if(this.isValidLevelState(levels.flags) && (previous === undefined || level >= previous)) {
            delete levels.intended;
            this.publishReported(accessory);
            return;
        }
        this.log.debug("Lightbulb :: %s :: a push left the flags mid-change; asking for the whole room",
            context.displayName);
        void this.client.requestDeviceStatus([DeviceType.LIGHT]);
    }

    register() {
        super.register();
        this.buildConfiguredAccessories();

        this.addDeviceListener((devices, metadata) => {
            const touched = new Map<PlatformAccessory, { index: number, on: boolean }[]>();
            for(const device of devices) {
                const accessory = this.findGroupAccessory(device.deviceId);
                if(!accessory) {
                    this.syncAccessory(device);
                    continue;
                }
                const levels = this.getAccessoryInterface(accessory).levels!;
                const index = levels.members.indexOf(device.deviceId);
                if(index < 0) {
                    continue;
                }
                const updates = touched.get(accessory) || [];
                updates.push({ index, on: device.op["status"] === "on" });
                touched.set(accessory, updates);
            }
            for(const [accessory, updates] of touched) {
                this.applyReport(accessory, updates, metadata);
            }
        });
    }
}
