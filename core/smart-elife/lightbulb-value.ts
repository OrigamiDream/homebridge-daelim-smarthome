/**
 * The `operation.value` a light reports, e.g. `light_999_050`.
 *
 * Read in two places that must not drift apart: the settings wizard, which decides from it
 * whether a light can be a step of a level, and the accessory, which drives the characteristics.
 * A light that dims or sets its colour on its own is richer than a level step and is left alone,
 * so the two have to agree on what "on its own" means.
 */

// HomeKit uses mired (micro reciprocal degrees). Typical range is 140..500.
export const MIRED_MIN_VALUE = 140;
export const MIRED_MAX_VALUE = 500;

/** What the device sends where a capability is absent. */
const UNSUPPORTED = 999;

export interface LightbulbValue {
    /** Device prefix, echoed back when the value is rebuilt. */
    prefix: string

    brightness: number
    brightnessAdjustable: boolean

    /** HomeKit/Home app value (mired), e.g. 140..500. */
    colorTemperature: number

    /** Hardware/native value, e.g. 0..100. */
    colorTemperatureHw: number

    colorTemperatureAdjustable: boolean
}

export function miredToHardwareColorTemperature(
    mired: number,
    minMired = MIRED_MIN_VALUE,
    maxMired = MIRED_MAX_VALUE,
): number {
    const clamped = Math.max(minMired, Math.min(maxMired, mired));
    const ratio = (maxMired - clamped) / (maxMired - minMired);

    return Math.round(ratio * 100);
}

export function hardwareToMiredColorTemperature(
    hw: number,
    minMired = MIRED_MIN_VALUE,
    maxMired = MIRED_MAX_VALUE,
): number {
    const clamped = Math.max(0, Math.min(100, hw));
    const mired = maxMired - (clamped / 100) * (maxMired - minMired);

    return Math.round(mired);
}

export function parseLightbulbValue(value: string): LightbulbValue {
    const values = `${value ?? ""}`.split("_");
    const colorTemperatureHw = Number(values[1]);
    const brightness = Number(values[2]);

    const colorTemperatureAdjustable = colorTemperatureHw !== UNSUPPORTED;
    const brightnessAdjustable = brightness !== UNSUPPORTED;

    // Where the device says "not adjustable" it uses 999; map HomeKit to a safe default.
    const colorTemperature = colorTemperatureAdjustable
        ? hardwareToMiredColorTemperature(colorTemperatureHw, MIRED_MIN_VALUE, MIRED_MAX_VALUE)
        : MIRED_MIN_VALUE;

    return {
        prefix: values[0],
        brightness,
        brightnessAdjustable,
        colorTemperature,
        colorTemperatureHw,
        colorTemperatureAdjustable,
    };
}
