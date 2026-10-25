/** Shape of the `get_device_info` result returned by the L900. */
export type DeviceInfo = {
	device_id: string;
	model: string;
	fw_ver: string;
	hw_ver?: string;
	/** Base64-encoded. */
	nickname: string;
	/** Base64-encoded. */
	ssid: string;
	rssi: number;
	device_on: boolean;
	brightness: number;
	hue: number;
	saturation: number;
	color_temp: number;
	color_temp_range?: [number, number];
	lighting_effect?: LightingEffect;
};

export type LightingEffect = {
	enable: 0 | 1 | boolean;
	id?: string;
	name?: string;
};

/** Parameters accepted by `set_device_info`. */
export type SetDeviceInfoParams = {
	device_on?: boolean;
	brightness?: number;
	hue?: number;
	saturation?: number;
	color_temp?: number;
};

/** Address of the strip, and the account hash it authenticates against. */
export type TapoConnection = {
	ip?: string;
	/** `userHash(email, password)`: what KLAP checks, in place of the password itself. */
	auth?: Buffer;
};

/** The L900 rejects a brightness of 0; the usable range starts at 1. */
export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 100;

/** Colour temperature range reported by the L900. */
export const TEMP_MIN = 2500;
export const TEMP_MAX = 9000;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Decodes the base64 fields the device returns for `nickname` and `ssid`. */
export function decodeField(value: string | undefined): string {
	if (!value) {
		return "";
	}
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return value;
	}
}
