// 在Web Worker中监听主线程发送的音频数据

self.onmessage = async function(event) {
  const audioData = event.data.data;
  const type = event.data.type;

  let blob;
  if (type === 'original') {
    blob = createBlobByOriginalAudioSource(audioData);
  } else if (type === 'mp3') {
    blob = await convertToMp3Blob(audioData);
  }

  blob && self.postMessage(blob);
};

async function convertToMp3Blob(audioData) {
  return new Blob([audioData], { type: 'audio/mpeg' });
}

function createBlobByOriginalAudioSource(audioData) {
  const buffer = createWavFile(audioData);
  return new Blob([buffer], { type: 'audio/mpeg' });
}

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

