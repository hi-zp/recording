type Without<T, U> = {
    [P in Exclude<keyof T, keyof U>]?: never;
};
type XOR<T, U> = T | U extends object ? (Without<T, U> & U) | (Without<U, T> & T) : T | U;
type Mp3CbrValues = 8 | 16 | 24 | 32 | 40 | 48 | 64 | 80 | 96 | 112 | 128 | 160 | 192 | 224 | 256 | 320;
type Mp3Params = XOR<{
    bitrate?: Mp3CbrValues;
}, {
    vbrQuality?: number;
}>;
declare function parseMp3Params(params: Mp3Params): Int32Array;
declare const Mp3Params: {
    mimeType: "audio/mpeg";
    parseParams: typeof parseMp3Params;
};
interface OggParams {
    vbrQuality?: number;
    oggSerialNo?: number;
}
declare function parseOggParams(params: OggParams): Int32Array;
declare const OggParams: {
    mimeType: "audio/ogg";
    parseParams: typeof parseOggParams;
};
interface BaseEncoderParams {
    channels: 1 | 2;
    sampleRate: number;
}
type DiscriminateUnion<T, K extends keyof T, V extends T[K]> = T extends Record<K, V> ? T : never;
type MapDiscriminatedUnion<T extends Record<K, string>, K extends keyof T> = {
    [V in T[K]]: DiscriminateUnion<T, K, V>;
};
type ConfigMap = MapDiscriminatedUnion<typeof Mp3Params | typeof OggParams, "mimeType">;
type EncoderParams<T extends keyof ConfigMap> = Parameters<ConfigMap[T]["parseParams"]>[0];
type SupportedMimeTypes = keyof ConfigMap;
declare class WasmMediaEncoder<MimeType extends SupportedMimeTypes> {
    readonly mimeType: MimeType;
    private readonly module;
    private readonly parseParams;
    private ref;
    private channelCount;
    private get_pcm;
    private get_out_buf;
    private constructor();
    static create<T extends SupportedMimeTypes>(mimeType: T, wasm: string | ArrayBuffer | Uint8Array | WebAssembly.Module, moduleCallback?: (module: WebAssembly.Module) => void): Promise<WasmMediaEncoder<T>>;
    configure(params: BaseEncoderParams & EncoderParams<MimeType>): void;
    encode(samples: Float32Array[]): Uint8Array;
    finalize(): Uint8Array;
}
declare const createEncoder: typeof WasmMediaEncoder.create;
declare function createMp3Encoder(): Promise<WasmMediaEncoder<"audio/mpeg">>;
declare function createOggEncoder(): Promise<WasmMediaEncoder<"audio/ogg">>;
export { createEncoder, createMp3Encoder, createOggEncoder, WasmMediaEncoder };
