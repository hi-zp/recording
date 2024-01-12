// audio-processor.js
import { createMp3Encoder } from "./wasm-media-encoders/dist/esnext/index.mjs"

class AudioProcessor extends AudioWorkletProcessor {
  constructor(_options) {
    super();
    this.port.onmessage = this.postMessage.bind(this);
    this.initEncoder();
  }

  size = 1024 * 100
  encoder = null
  outBuffer = new Uint8Array(1024 * 100);
  offset = 0

  logState = false

  async initEncoder() {
    this.encoder = await createMp3Encoder()
    this.encoder.configure({
      sampleRate: 48000,
      channels: 2,
      vbrQuality: 8,
    });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!this.logState) {
      console.log("input", input)
      this.logState = true
    }
    
    // 将输入音频数据复制到输出 - 处理输出
    // for (let channel = 0; channel < input.length; ++channel) {
    //   output[channel].set(input[channel]);
    // }

    this.bufferInterceptor(inputs[0])

    return true;
  }

  bufferInterceptor(pmcSource) {
    if (!this.encoder) return;

    const mp3Data = this.encoder.encode(pmcSource)

    if (mp3Data.length === 0) {
      return true;
    }

    const newBuffer = new Uint8Array(mp3Data.length);
    newBuffer.set(mp3Data)

    for (let i = 0; i < newBuffer.length; i++) {
      let rate = newBuffer[i];
      if (this.offset === this.size) {
        this.postMessage(this.outBuffer);

        // reset state
        this.outBuffer = new Uint8Array(this.size);
        this.offset = 0;
      }
      this.outBuffer[this.offset] = rate;
      this.offset++;
    }
  }

  /** 处理消息 */
  postMessage(event) {
    this.port.postMessage(event);
  }
}

registerProcessor('audio-processor', AudioProcessor);