// Generate random room name if needed
if (!location.hash) {
  location.hash = Math.floor(Math.random() * 0xFFFFFF).toString(16);
}
const roomHash = location.hash.substring(1);

const drone = new ScaleDrone('fWvCErYhhdy2yLS7');

const roomName = 'observable-' + roomHash;
const configuration = {
  iceServers: [{
    urls: 'stun:stun.l.google.com:19302'
  }]
};

let room;
let pc;
let audioFactory = new AudioFactory();

function onSuccess() {};
function onError(error) {
  console.error(error);
};

drone.on('open', error => {
  if (error) {
    return console.error(error);
  }
  room = drone.subscribe(roomName);
  room.on('open', error => {
    if (error) {
      onError(error);
    }
  });
  // We're connected to the room and received an array of 'members'
  // connected to the room (including us). Signaling server is ready.
  room.on('members', members => {
    console.log('MEMBERS', members);
    // If we are the second user to connect to the room we will be creating the offer
    const isOfferer = members.length === 2;
    startWebRTC(isOfferer);
  });
});

// Send signaling data via Scaledrone
function sendMessage(message) {
  drone.publish({
    room: roomName,
    message
  });
}

function startWebRTC(isOfferer) {
  pc = new RTCPeerConnection(configuration);

  // 'onicecandidate' notifies us whenever an ICE agent needs to deliver a
  // message to the other peer through the signaling server
  pc.onicecandidate = event => {
    if (event.candidate) {
      sendMessage({'candidate': event.candidate});
    }
  };

  // If user is offerer let the 'negotiationneeded' event create the offer
  if (isOfferer) {
    pc.onnegotiationneeded = () => {
      pc.createOffer().then(localDescCreated).catch(onError);
    }
  }

  // When a remote stream arrives display it in the #remoteVideo element
  pc.ontrack = event => {
    const stream = event.streams[0];
    if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) {
      remoteVideo.srcObject = stream;
      audioFactory.setStream(stream);
    }
  };

  navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // googEchoCancellation: true,
      // googNoiseSuppression: true,
      // googAutoGainControl: true,
      sampleRate: 16000,
      // channelCount: 1
    },
    video: false,
  }).then(stream => {
    // localVideo.srcObject = stream;
    // Add your stream to be sent to the conneting peer
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    audioFactory.setStream(stream);
  }, onError);

  // Listen to signaling data from Scaledrone
  room.on('data', (message, client) => {
    // Message was sent by us
    if (client.id === drone.clientId) {
      return;
    }

    if (message.sdp) {
      // This is called after receiving an offer or answer from another peer
      pc.setRemoteDescription(new RTCSessionDescription(message.sdp), () => {
        // When receiving an offer lets answer it
        if (pc.remoteDescription.type === 'offer') {
          pc.createAnswer().then(localDescCreated).catch(onError);
        }
      }, onError);
    } else if (message.candidate) {
      // Add the new ICE candidate to our connections remote description
      pc.addIceCandidate(
        new RTCIceCandidate(message.candidate), onSuccess, onError
      );
    }
  });
}

function localDescCreated(desc) {
  pc.setLocalDescription(
    desc,
    () => sendMessage({'sdp': pc.localDescription}),
    onError
  );
}

function AudioFactory() {
  this._streams = [];
  this._sources = [];
}

AudioFactory.prototype.setStream = function(stream) {
  this._streams.push(stream);
  if (this._streams.length === 1) {
    this._mergeAudio();
  }
}

AudioFactory.prototype._mergeAudio = async function() {
  // create AudioContext
  const audioContext = new AudioContext();

  this._streams.forEach((stream) => {
    this._sources.push(audioContext.createMediaStreamSource(stream));
  });

  // create mixer
  const mixerNode = audioContext.createGain();

  // link audio source to mixer
  this._sources.forEach((source) => {
    source.connect(mixerNode);
  });

  // const response = await fetch('https://unpkg.com/wasm-media-encoders@0.6.4/wasm/mp3.wasm');
  // const wasmBytes = await response.arrayBuffer();
  // const wasmModule = await WebAssembly.instantiate(wasmBytes);

  const worker = new Worker('encode-processor.js', { type: 'module' });


  let saved = false;

  // 监听Web Worker发送的消息
  worker.onmessage = function(event) {
    const audioBlob = event.data;

    if (saved)  {
      return;
    }
    
    // 下载
    const url = URL.createObjectURL(audioBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'audio' +  Date.now() + '.mpeg';
    link.click();
    URL.revokeObjectURL(url);

    saved = true

    // 将音频数据存储为文件格式
    // 这里可以使用合适的库或技术来进行文件格式的编码和存储
    // 例如，可以使用Web Audio API的AudioBuffer将音频数据转换为WAV格式，然后使用File API将其保存为文件
    // ...

    console.log("音频数据已存储为文件格式");
  };


  audioContext.audioWorklet.addModule('audio-processor.js').then(() => {

    // 创建AudioWorkletNode
    const workletNode = new AudioWorkletNode(audioContext, 'audio-processor', {
      processorOptions: {
        // fetch: fetch,
        // wasmInstance: wasmModule.instance
      }
    });

    // send to Worker
    workletNode.port.onmessage = (event) => {
      worker.postMessage({
        type: 'mp3',
        data: event.data
      })
    }

    // 连接混合器到AudioWorkletNode
    mixerNode.connect(workletNode);

    // 连接AudioWorkletNode到AudioContext的输出
    // workletNode.connect(audioContext.destination);
  })
}
