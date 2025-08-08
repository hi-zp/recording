// audio-processor.js
import { createMp3Encoder } from "./wasm-media-encoders/dist/esnext/index.mjs";

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.port.onmessage = this.postMessage.bind(this);
    this.actualSampleRate = options.processorOptions?.sampleRate || sampleRate;
    this.initEncoder();
  }

  size = 1024 * 100;
  encoder = null;
  outBuffer = new Uint8Array(1024 * 100);
  offset = 0;
  logState = false;

  async initEncoder() {
    this.encoder = await createMp3Encoder();
    this.encoder.configure({
      sampleRate: this.actualSampleRate,
      channels: 2,
      vbrQuality: 8,
    });
    this.port.postMessage({ type: 'encoder-ready', sampleRate: this.actualSampleRate });
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.logState) {
      console.log("AudioProcessor - Sample rate:", this.actualSampleRate);
      console.log("AudioProcessor - Input:", input);
      this.logState = true;
    }
    this.bufferInterceptor(input);
    return true;
  }

  bufferInterceptor(pmcSource) {
    if (!this.encoder) return;
    const mp3Data = this.encoder.encode(pmcSource);
    if (mp3Data.length === 0) return true;
    const newBuffer = new Uint8Array(mp3Data.length);
    newBuffer.set(mp3Data);
    for (let i = 0; i < newBuffer.length; i++) {
      const rate = newBuffer[i];
      if (this.offset === this.size) {
        this.postMessage(this.outBuffer);
        this.outBuffer = new Uint8Array(this.size);
        this.offset = 0;
      }
      this.outBuffer[this.offset] = rate;
      this.offset++;
    }
  }

  postMessage(event) {
    this.port.postMessage(event);
  }
}

registerProcessor('audio-processor', AudioProcessor);
