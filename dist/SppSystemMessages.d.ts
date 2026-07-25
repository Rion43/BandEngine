export declare function encodeCommandClock(): Uint8Array;
export declare function encodeCommandDeviceInfo(): Uint8Array;
export declare function encodeCommandBattery(): Uint8Array;
/** Gadgetbridge Command{type=X, subtype=Y} protobuf encoder.
 *  Birebir XiaomiSupport.sendCommand(taskName, type, subtype) ile ayni:
 *    Command.newBuilder().setType(type).setSubtype(subtype).build()
 */
export declare function encodeCommandRaw(type: number, subtype: number): Uint8Array;
