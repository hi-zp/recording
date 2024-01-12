// audio-processor.js
import { createMp3Encoder } from "./wasm-media-encoders/dist/esnext/index.mjs"

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.port.onmessage = this.handleMessage.bind(this);
    this._initEncoder();
  }

  encoder = null
  outBuffer = new Uint8Array(1024 * 500);
  offset = 0

  leftBuffer = [];
  rightBuffer = [];

  async _initEncoder() {
    this.encoder = await createMp3Encoder()
    /* Configure and use the encoder */
    this.encoder.configure({
      sampleRate: 16000,
      channels: 2,
      vbrQuality: 0,
    });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (this.leftBuffer.length <= 1024 * 5) {
      if (input && input[0] && input[1]) {
        this.leftBuffer.push(new Float32Array(input[0]))
        this.rightBuffer.push(new Float32Array(input[1]))
      }
    } else {
      const leftData = this.flatArray(this.leftBuffer);
      const rightData = this.flatArray(this.rightBuffer);
      this.handleMessage({
        type: 'input',
        data: this.interleaveLeftAndRight(leftData, rightData),
      })
      this.leftBuffer = []
      this.rightBuffer = []
    }
    
    // 将输入音频数据复制到输出
    for (let channel = 0; channel < input.length; ++channel) {
      output[channel].set(input[channel]);
    }

    if (this.encoder) {
      const mp3Data = this.encoder.encode(output)

      if (mp3Data.length + this.offset > this.outBuffer.length) {
        // 完成分片
        this.encoder.finalize();
        const buffer = new Uint8Array(this.outBuffer.buffer, 0, this.offset);
        this.handleMessage({
          type: 'finish',
          data: buffer
        })

        // 创建新的缓冲区
        const newBuffer = new Uint8Array(mp3Data.length + this.offset);
        newBuffer.set(this.outBuffer);
        this.outBuffer = newBuffer;
        this.offset = 0;
      }

      this.outBuffer.set(mp3Data, this.offset);
      this.offset += mp3Data.length;

      // console.log('outBuffer', this.outBuffer)
    }

    return true;
  }

  /**
   * Handles a message event.
   *
   * @param {event} event - the message event
   */
  handleMessage(event) {
    this.port.postMessage(event);
  }

  // 二维转一维
  flatArray(list) {
      // 拿到总长度
      const length = list.length * list[0].length;
      const data = new Float32Array(length);
      let offset = 0;
      for(let i = 0; i < list.length; i++) {
          data.set(list[i], offset);
          offset += list[i].length;
      }
      return data
  }

  // 穿插兼并左右数据
  interleaveLeftAndRight(left, right) {
    const length = left.length + right.length;
    const data = new Float32Array(length);
    for (let i = 0; i < left.length; i++) {
        const k = i * 2;
        data[k] = left[i];
        data[k + 1] = right[i]; 
    }
    return data;
  }
}

registerProcessor('audio-processor', AudioProcessor);