// 在Web Worker中监听主线程发送的音频数据（遵循 audio_merge_push 实现）
let currentSampleRate = 44100; // 默认采样率

self.onmessage = async function(event) {
  const type = event.data.type;
  
  if (type === 'config') {
    // 接收采样率配置
    currentSampleRate = event.data.sampleRate;
    console.log("Worker received sample rate:", currentSampleRate);
    return;
  }
  
  const audioData = event.data.data;

  let blob;
  if (type === 'original') {
    blob = createBlobByOriginalAudioSource(audioData);
  } else if (type === 'mp3') {
    blob = await convertToMp3Blob(audioData);
  }

  blob && self.postMessage(blob);
};

async function convertToMp3Blob(audioData) {
  return new Blob([audioData], { type: 'audio/mp3' });
}

function createBlobByOriginalAudioSource(audioData) {
  const buffer = createWavFile(audioData);
  return new Blob([buffer], { type: 'audio/wav' });
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
    view = new DataView(buffer);
  writeUTFBytes(view, 0, "RIFF");
  view.setUint32(4, 36 + audioData.length * 2, true);
  writeUTFBytes(view, 8, "WAVE");
  writeUTFBytes(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, currentSampleRate, true);
  view.setUint32(28, currentSampleRate * 2, true);
  view.setUint16(32, 2 * 2, true);
  view.setUint16(34, 16, true);
  writeUTFBytes(view, 36, "data");
  view.setUint32(40, audioData.length * 2, true);
  let length = audioData.length;
  let index = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, audioData[i]));
    view.setInt16(index, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    index += 2;
  }
  return buffer;
}
