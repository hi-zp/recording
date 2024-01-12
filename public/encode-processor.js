// 在Web Worker中监听主线程发送的音频数据

function writeUTFBytes(view, offset, string) {
  var lng = string.length;
  for (var i = 0; i < lng; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function createWavFile(audioData) {
  const WAV_HEAD_SIZE = 44;
  let buffer = new ArrayBuffer(audioData.length * 2 + WAV_HEAD_SIZE),
    // 需要用一个view来操控buffer
    view = new DataView(buffer);
  // 写入wav头部信息
  // RIFF chunk descriptor/identifier
  writeUTFBytes(view, 0, "RIFF");
  // RIFF chunk length
  view.setUint32(4, 36 + audioData.length * 2, true);
  // RIFF type
  writeUTFBytes(view, 8, "WAVE");
  // format chunk identifier
  // FMT sub-chunk
  writeUTFBytes(view, 12, "fmt ");
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true);
  // stereo (2 channels)
  view.setUint16(22, 2, true);
  // sample rate
  view.setUint32(24, 44100, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, 44100 * 2, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, 2 * 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data sub-chunk
  // data chunk identifier
  writeUTFBytes(view, 36, "data");
  // data chunk length
  view.setUint32(40, audioData.length * 2, true);
  // 写入PCM数据
  let length = audioData.length;
  let index = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, audioData[i]));
    view.setInt16(index, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    index += 2;
  }
  return buffer;
}

self.onmessage = function(event) {
  const audioData = event.data.data;
  const buffer = createWavFile(audioData);
  console.log(buffer)
  const blob = new Blob([buffer], { type: 'audio/wav' });

  // 将音频数据存储为文件格式
  // 这里可以使用合适的库或技术来进行文件格式的编码和存储
  // 例如，可以使用Web Audio API的AudioBuffer将音频数据转换为WAV格式，然后使用File API将其保存为文件
  // ...

  // 将结果发送回主线程
  self.postMessage(blob);
};

// // default path is on the same directory as Mp3LameEncoder.min.js
// self.Mp3LameEncoderConfig = {
//   memoryInitializerPrefixURL: "./memory/"
//   // => changed to javascripts/memory/Mp3LameEncoder.min.js.mem
// };
// importScripts("Mp3LameEncoder.min.js");