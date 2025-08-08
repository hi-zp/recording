'use client';

import React, { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

type RTCClientProps = { room: string };

class AudioFactory {
  private _streams: MediaStream[] = [];
  private _sources: MediaStreamAudioSourceNode[] = [];
  private _context: AudioContext | null = null;
  private _worker: Worker | null = null;
  private _workletNode: AudioWorkletNode | null = null;

  setStream(stream: MediaStream) {
    this._streams.push(stream);
    if (this._streams.length === 2) {
      this._startProcessing();
    }
  }

  async _startProcessing() {
    try {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const actualSampleRate = audioContext.sampleRate;
      this._context = audioContext;

      const mixerNode = audioContext.createGain();

      this._streams.forEach((stream) => {
        const source = audioContext.createMediaStreamSource(stream);
        this._sources.push(source);
        source.connect(mixerNode);
      });

      const worker = new Worker('/encode-processor.js', { type: 'module' });
      this._worker = worker;

      worker.onmessage = (event) => {
        const audioBlob: Blob | null = event.data;
        if (!audioBlob) return;
        const url = URL.createObjectURL(audioBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `audio_${Date.now()}.mp3`;
        link.click();
        URL.revokeObjectURL(url);
      };

      await audioContext.audioWorklet.addModule('/audio-processor.js');

      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor', {
        processorOptions: { sampleRate: actualSampleRate },
      });
      this._workletNode = workletNode;

      workletNode.port.onmessage = (event) => {
        if (!this._worker) return;
        if (event.data?.type === 'encoder-ready') {
          this._worker.postMessage({ type: 'config', sampleRate: event.data.sampleRate });
        } else {
          this._worker.postMessage({ type: 'mp3', data: event.data });
        }
      };

      mixerNode.connect(workletNode);
      // eslint-disable-next-line no-console
      console.log('Audio merging setup completed, sample rate:', actualSampleRate);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error setting up audio merging:', error);
    }
  }

  cleanup() {
    try {
      if (this._worker) {
        this._worker.terminate();
        this._worker = null;
      }
      if (this._context) {
        this._context.close();
        this._context = null;
      }
    } finally {
      this._streams = [];
      this._sources = [];
      this._workletNode = null;
    }
  }
}

export default function RTCClient({ room }: RTCClientProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState('Waiting for connection...');
  const [scaleDroneLoaded, setScaleDroneLoaded] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [roomUrl, setRoomUrl] = useState('');

  const audioFactoryRef = useRef<AudioFactory | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const droneRef = useRef<any>(null);
  const roomRef = useRef<any>(null);
  const pendingRemoteCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  // 计算房间链接
  useEffect(() => {
    if (typeof window !== 'undefined' && room) {
      setRoomUrl(`${window.location.origin}${window.location.pathname}?room=${room}`);
    }
  }, [room]);

  // 初始化AudioFactory
  useEffect(() => {
    const factory = new AudioFactory();
    audioFactoryRef.current = factory;
    return () => factory.cleanup();
  }, [room]);

  // 页面加载时自动请求权限
  const requestPermission = async () => {
    try {
      setStatus('Requesting microphone permission...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionGranted(true);
      setPermissionDenied(false);
      setStatus('Microphone permission granted');
    } catch (error: any) {
      setPermissionDenied(true);
      setStatus(error?.name === 'NotAllowedError' ? 'Permission denied' : `Permission error: ${error?.message || 'Unknown'}`);
    }
  };

  useEffect(() => {
    requestPermission();
  }, []);

  // 设备检查
  const checkAudioDevices = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Browser does not support audio capture');
      return false;
    }
    if (navigator.permissions) {
      try {
        const mic = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (mic.state === 'denied') {
          setStatus('Microphone permission denied');
          return false;
        }
      } catch (_) {}
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length === 0) {
      setStatus('No audio input device');
      return false;
    }
    return true;
  };

  // 上传逻辑在遵循 audio_merge_push 时不启用（保留接口文件以备后续切换）

  const initializeRTC = async () => {
    if (!scaleDroneLoaded || !audioFactoryRef.current) return;
    if (!permissionGranted) {
      setStatus('Waiting for microphone permission...');
      return;
    }
    const ok = await checkAudioDevices();
    if (!ok) return;

    const drone = new (window as any).ScaleDrone('fWvCErYhhdy2yLS7');
    droneRef.current = drone;

    const roomName = 'observable-' + room;
    const configuration: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const audioFactory = audioFactoryRef.current;

    function onError(error: any) {
      // eslint-disable-next-line no-console
      console.error(error);
      setStatus('发生错误，请查看控制台');
    }

    function sendMessage(message: any) {
      drone.publish({ room: roomName, message });
    }

    function localDescCreated(desc: RTCSessionDescriptionInit) {
      pcRef.current?.setLocalDescription(desc).then(() => {
        sendMessage({ sdp: pcRef.current?.localDescription });
      }).catch(onError);
    }

    function startWebRTC(isOfferer: boolean) {
      const pc = new RTCPeerConnection(configuration);
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) sendMessage({ candidate: event.candidate });
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') setStatus('Peer connected');
      };

      if (isOfferer) {
        pc.onnegotiationneeded = () => {
          pc.createOffer().then((offer) => localDescCreated(offer)).catch(onError);
        };
      }

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (remoteVideoRef.current && (!remoteVideoRef.current.srcObject || (remoteVideoRef.current.srcObject as MediaStream).id !== stream.id)) {
          remoteVideoRef.current.srcObject = stream;
          audioFactory?.setStream(stream);
          setStatus('Remote audio stream connected');
        }
      };

      const getMediaStream = async () => {
        try {
          setStatus('Getting media stream...');
          let stream: MediaStream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: { ideal: 16000 },
                channelCount: { ideal: 2 },
              },
              video: false,
            });
          } catch (_) {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          }
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) throw new Error('No audio track found');
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));
          audioFactory?.setStream(stream);
          setStatus('Local audio stream connected');
        } catch (error: any) {
          setStatus(`Audio device error: ${error?.message || 'Unknown'}`);
          onError(error);
        }
      };

      getMediaStream();
    }

    drone.on('open', (error: any) => {
      if (error) {
        // eslint-disable-next-line no-console
        console.error('Scaledrone open error', error);
        setStatus('Signaling connection failed');
        return;
      }
      setStatus('Signaling connection successful');

      const roomObj = drone.subscribe(roomName);
      roomRef.current = roomObj;

      roomObj.on('open', (err: any) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.error('Room join error', err);
          setStatus('Failed to join room');
        }
      });

      roomObj.on('members', (members: any[]) => {
        const isOfferer = members.length >= 2;
        if (!pcRef.current) startWebRTC(isOfferer);
        setStatus(`Room members: ${members.length}, ${isOfferer ? 'Initiator' : 'Receiver'}`);
      });

      roomObj.on('data', (message: any, member: any) => {
        if (!pcRef.current) return;
        if (member?.id === drone.clientId) return;
        const pc = pcRef.current;
        if (message?.sdp) {
          pc.setRemoteDescription(new RTCSessionDescription(message.sdp))
            .then(() => {
              if (pc.remoteDescription?.type === 'offer') {
                pc.createAnswer().then((answer) => localDescCreated(answer)).catch(onError);
              }
              // flush queued ICE candidates
              const queued = pendingRemoteCandidatesRef.current.splice(0);
              queued.forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)).catch(onError));
            })
            .catch(onError);
        } else if (message?.candidate) {
          if (!pc.remoteDescription) {
            pendingRemoteCandidatesRef.current.push(message.candidate);
          } else {
            pc.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(onError);
          }
        }
      });
    });

    // 页面卸载时自动收尾
    return () => {
      pcRef.current?.close();
      try { droneRef.current?.close?.(); } catch (_) {}
    };
  };

  useEffect(() => {
    if (scaleDroneLoaded) initializeRTC();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleDroneLoaded, permissionGranted]);

  const copyRoomUrl = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl);
      setStatus('Room link copied to clipboard');
    } catch {
      setStatus('Copy failed');
    }
  };

  return (
    <>
      <Script src="https://cdn.scaledrone.com/scaledrone.min.js" onLoad={() => setScaleDroneLoaded(true)} />
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-100 p-4">
        <div className="max-w-6xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
            <h1 className="text-3xl font-bold text-gray-800 mb-2">RTC Audio Recording</h1>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <div
                  className={`w-3 h-3 rounded-full ${
                    status.includes('successful') || status.includes('connected')
                      ? 'bg-green-500'
                      : status.includes('failed') || status.includes('error')
                        ? 'bg-red-500'
                        : 'bg-yellow-500'
                  }`}
                ></div>
                <span className="text-sm font-medium text-gray-700">{status}</span>
              </div>

              {permissionDenied && (
                <button
                  onClick={requestPermission}
                  className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors duration-200"
                >
                  Re-authorize Microphone
                </button>
              )}

              {permissionGranted && (
                <div className="flex items-center space-x-2">
                  <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm font-medium text-green-600">Microphone Authorized</span>
                </div>
              )}
            </div>
          </div>

          {roomUrl && (
            <div className="bg-white rounded-lg shadow p-4 mb-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-3">Room Link</h3>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={roomUrl}
                  readOnly
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-sm text-gray-700"
                />
                <button
                  onClick={copyRoomUrl}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-colors duration-200 flex items-center space-x-2"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                    <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                  </svg>
                  <span>Copy Link</span>
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">Share this link for others to join the same room</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-lg font-semibold text-gray-800 mb-3">Local Audio</h3>
              <video ref={localVideoRef} autoPlay muted className="w-full h-32 bg-gray-100 rounded border-2 border-gray-200" />
              <p className="text-sm text-gray-500 mt-2">Your audio stream</p>
            </div>

            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-lg font-semibold text-gray-800 mb-3">Remote Audio</h3>
              <video ref={remoteVideoRef} autoPlay muted className="w-full h-32 bg-gray-100 rounded border-2 border-gray-200" />
              <p className="text-sm text-gray-500 mt-2">Remote audio stream</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

