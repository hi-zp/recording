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
  private _onEncoderReady: ((sampleRate: number) => void) | null = null;
  private _onAudioContextReady: ((sampleRate: number) => void) | null = null;
  private _onWorkerChunk: ((blob: Blob) => void) | null = null;

  setStream(stream: MediaStream) {
    this._streams.push(stream);
    if (this._streams.length === 2) {
      this._startProcessing();
    }
  }

  setOnEncoderReady(cb: (sampleRate: number) => void) {
    this._onEncoderReady = cb;
  }

  setOnAudioContextReady(cb: (sampleRate: number) => void) {
    this._onAudioContextReady = cb;
  }

  setOnWorkerChunk(cb: (blob: Blob) => void) {
    this._onWorkerChunk = cb;
  }

  async _startProcessing() {
    try {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const actualSampleRate = audioContext.sampleRate;
      this._context = audioContext;
      this._onAudioContextReady?.(actualSampleRate);

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
        this._onWorkerChunk?.(audioBlob);
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
          const sr = event.data.sampleRate;
          this._onEncoderReady?.(sr);
          this._worker.postMessage({ type: 'config', sampleRate: sr });
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
  const [localState, setLocalState] = useState<{
    micGranted: boolean;
    deviceReady: boolean;
    streamActive: boolean;
    sampleRate?: number;
    micLevel?: number;
  }>({ micGranted: false, deviceReady: false, streamActive: false });
  const [remoteState, setRemoteState] = useState<{
    streamActive: boolean;
    micLevel?: number;
  }>({ streamActive: false });
  const [rtcState, setRtcState] = useState<{
    signaling: 'idle' | 'open' | 'error';
    pcState?: RTCPeerConnectionState;
    iceState?: RTCIceConnectionState;
    pendingCandidates: number;
  }>({ signaling: 'idle', pendingCandidates: 0 });
  const [encodeState, setEncodeState] = useState<{
    contextSampleRate?: number;
    encoderSampleRate?: number;
    chunkCount: number;
  }>({ chunkCount: 0 });
  const [scaleDroneLoaded, setScaleDroneLoaded] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [roomUrl, setRoomUrl] = useState('');
  // 设备列表与选择
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[] }>({ mics: [], cams: [] });
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [selectedCamId, setSelectedCamId] = useState<string>('');

  const audioFactoryRef = useRef<AudioFactory | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const didApplyInitialSelectedMicRef = useRef<boolean>(false);
  const droneRef = useRef<any>(null);
  const roomRef = useRef<any>(null);
  const pendingRemoteCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  // 本地音量检测相关
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterAnalyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const cleanupMeter = () => {
    if (meterRafRef.current) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    try { meterAnalyserRef.current?.disconnect(); } catch {}
    meterAnalyserRef.current = null;
    if (meterCtxRef.current) {
      try { meterCtxRef.current.close(); } catch {}
      meterCtxRef.current = null;
    }
  };
  // 远端音量检测资源
  const rMeterCtxRef = useRef<AudioContext | null>(null);
  const rMeterAnalyserRef = useRef<AnalyserNode | null>(null);
  const rMeterRafRef = useRef<number | null>(null);
  const cleanupRemoteMeter = () => {
    if (rMeterRafRef.current) {
      cancelAnimationFrame(rMeterRafRef.current);
      rMeterRafRef.current = null;
    }
    try { rMeterAnalyserRef.current?.disconnect(); } catch {}
    rMeterAnalyserRef.current = null;
    if (rMeterCtxRef.current) {
      try { rMeterCtxRef.current.close(); } catch {}
      rMeterCtxRef.current = null;
    }
  };

  // 枚举设备并初始化默认选择
  const enumerateDevices = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter((d) => d.kind === 'audioinput');
      const cams = list.filter((d) => d.kind === 'videoinput');
      setDevices({ mics, cams });
      if (!selectedMicId && mics.length > 0) setSelectedMicId(mics[0].deviceId || '');
      if (!selectedCamId && cams.length > 0) setSelectedCamId(cams[0].deviceId || '');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('enumerateDevices failed', e);
    }
  };

  useEffect(() => {
    if (!permissionGranted) return;
    enumerateDevices();
    const handler = () => enumerateDevices();
    try {
      navigator.mediaDevices.addEventListener('devicechange', handler);
      return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
    } catch (_) {
      // Safari 旧版可能不支持 addEventListener，这里忽略
      return undefined;
    }
  }, [permissionGranted]);

  // 设备枚举完成后，若本地轨道未使用所选麦克风，则自动对齐一次
  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream || !selectedMicId || didApplyInitialSelectedMicRef.current === true) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const settings = (track.getSettings && track.getSettings()) || {};
    const currentDeviceId = (settings as any).deviceId as string | undefined;
    if (!currentDeviceId || currentDeviceId !== selectedMicId) {
      didApplyInitialSelectedMicRef.current = true;
      updateLocalTracks('audio');
    }
  }, [selectedMicId]);

  // 根据选择构建约束
  const buildGumConstraints = () => {
    const audio: MediaTrackConstraints | boolean = selectedMicId
      ? {
          deviceId: { exact: selectedMicId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 16000 },
          channelCount: { ideal: 2 },
        }
      : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 16000 },
          channelCount: { ideal: 2 },
        };
    const video: MediaTrackConstraints | boolean = selectedCamId
      ? {
          deviceId: { exact: selectedCamId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: 'user',
        }
      : {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: 'user',
        };
    return { audio, video } as MediaStreamConstraints;
  };

  // 刷新编码工厂以适配新的本地/远端流
  const refreshAudioFactory = (local: MediaStream | null, remote: MediaStream | null) => {
    try {
      audioFactoryRef.current?.cleanup();
    } catch {}
    const factory = new AudioFactory();
    factory.setOnAudioContextReady((sr) => setEncodeState((s) => ({ ...s, contextSampleRate: sr })));
    factory.setOnEncoderReady((sr) => setEncodeState((s) => ({ ...s, encoderSampleRate: sr })));
    factory.setOnWorkerChunk(() => setEncodeState((s) => ({ ...s, chunkCount: s.chunkCount + 1 })));
    audioFactoryRef.current = factory;
    if (local) factory.setStream(local);
    if (remote) factory.setStream(remote);
  };

  // 切换本地设备并替换发送轨
  const updateLocalTracks = async (kind?: 'audio' | 'video') => {
    try {
      const constraints = buildGumConstraints();
      let newStream: MediaStream | null = null;
      try {
        newStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (_) {
        // 回退：只请求变化的轨道
        if (kind === 'audio') {
          newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
        } else if (kind === 'video') {
          newStream = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false });
        } else {
          newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      }
      if (!newStream) return;

      const pc = pcRef.current;
      const oldStream = localStreamRef.current;

      const newAudio = newStream.getAudioTracks()[0] || null;
      const newVideo = newStream.getVideoTracks()[0] || null;

      // 提示浏览器进行语音优化
      try {
        if (newAudio && 'contentHint' in newAudio) {
          (newAudio as any).contentHint = 'speech';
        }
      } catch {}

      // 替换发送端轨道
      if (pc) {
        const senders = pc.getSenders();
        if (newAudio) {
          const aSender = senders.find((s) => s.track && s.track.kind === 'audio');
          await aSender?.replaceTrack(newAudio);
        }
        if (newVideo) {
          const vSender = senders.find((s) => s.track && s.track.kind === 'video');
          await vSender?.replaceTrack(newVideo);
        }
      }

      // 更新本地展示流，尽量复用旧的 MediaStream 容器
      let targetStream = oldStream || new MediaStream();
      if (oldStream) {
        // 移除旧轨并停止
        if (kind !== 'video') {
          oldStream.getAudioTracks().forEach((t) => { t.stop(); oldStream.removeTrack(t); });
        }
        if (kind !== 'audio') {
          oldStream.getVideoTracks().forEach((t) => { t.stop(); oldStream.removeTrack(t); });
        }
      }
      if (newAudio) targetStream.addTrack(newAudio);
      if (newVideo) targetStream.addTrack(newVideo);
      localStreamRef.current = targetStream;
      if (localVideoRef.current) localVideoRef.current.srcObject = targetStream;

      // 重启本地音量计
      if (newAudio) {
        try {
          cleanupMeter();
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const source = ctx.createMediaStreamSource(targetStream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.2;
          source.connect(analyser);
          meterCtxRef.current = ctx;
          meterAnalyserRef.current = analyser;
          const data = new Uint8Array(analyser.fftSize);
          const tick = () => {
            if (!meterAnalyserRef.current) return;
            meterAnalyserRef.current.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            const level = Math.min(1, rms * 2.5);
            setLocalState((s) => ({ ...s, micLevel: level, streamActive: true }));
            meterRafRef.current = requestAnimationFrame(tick);
          };
          meterRafRef.current = requestAnimationFrame(tick);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('restart meter failed', e);
        }
      }

      // 监听新音频轨道的静音状态并尝试恢复
      try {
        if (newAudio) {
          const onMute = () => {
            // 延迟片刻以避免瞬时静音误判
            setTimeout(() => {
              // 若仍在使用该轨并且静音，尝试重置采集
              if (localStreamRef.current?.getAudioTracks()[0] === newAudio && newAudio.muted) {
                updateLocalTracks('audio');
              }
            }, 800);
          };
          newAudio.addEventListener('mute', onMute);
          // 清理旧监听
          const oldAudio = oldStream?.getAudioTracks()[0];
          if (oldAudio) {
            try { oldAudio.removeEventListener('mute', onMute as any); } catch {}
          }
        }
      } catch {}

      // 让编码工厂使用最新的本地/远端流
      const remoteStream = (remoteVideoRef.current?.srcObject || null) as MediaStream | null;
      refreshAudioFactory(targetStream, remoteStream);

      setStatus('Device switched');
    } catch (e: any) {
      setStatus(`Switch device failed: ${e?.message || 'Unknown'}`);
    }
  };

  // 计算房间链接
  useEffect(() => {
    if (typeof window !== 'undefined' && room) {
      setRoomUrl(`${window.location.origin}${window.location.pathname}?room=${room}`);
    }
  }, [room]);

  // 初始化AudioFactory
  useEffect(() => {
    const factory = new AudioFactory();
    factory.setOnAudioContextReady((sr) => setEncodeState((s) => ({ ...s, contextSampleRate: sr })));
    factory.setOnEncoderReady((sr) => setEncodeState((s) => ({ ...s, encoderSampleRate: sr })));
    factory.setOnWorkerChunk(() => setEncodeState((s) => ({ ...s, chunkCount: s.chunkCount + 1 })));
    audioFactoryRef.current = factory;
    return () => factory.cleanup();
  }, [room]);

  // 页面加载时自动请求权限
  const requestPermission = async () => {
    try {
      setStatus('Requesting microphone permission...');
      // 优先同时请求麦克风与摄像头权限
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      } catch (_) {
        // 回退仅麦克风
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      stream.getTracks().forEach((t) => t.stop());
      setPermissionGranted(true);
      setPermissionDenied(false);
      setStatus('Media permission granted');
      setLocalState((s) => ({ ...s, micGranted: true }));
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
      setLocalState((s) => ({ ...s, deviceReady: false }));
      return false;
    }
    if (navigator.permissions) {
      try {
        const mic = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (mic.state === 'denied') {
          setStatus('Microphone permission denied');
          setLocalState((s) => ({ ...s, deviceReady: false }));
          return false;
        }
      } catch (_) {}
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length === 0) {
      setStatus('No audio input device');
      setLocalState((s) => ({ ...s, deviceReady: false }));
      return false;
    }
    setLocalState((s) => ({ ...s, deviceReady: true }));
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
        setRtcState((s) => ({ ...s, pcState: state }));
        if (state === 'connected') setStatus('Peer connected');
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          // 远端离开/异常，更新远端状态与清理音量检测
          setStatus('Peer disconnected');
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null as any;
          setRemoteState({ streamActive: false, micLevel: 0 });
          cleanupRemoteMeter();
        }
      };

      pc.oniceconnectionstatechange = () => {
        const ice = pc.iceConnectionState;
        setRtcState((s) => ({ ...s, iceState: ice }));
        if (ice === 'disconnected' || ice === 'failed' || ice === 'closed') {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null as any;
          setRemoteState({ streamActive: false, micLevel: 0 });
          cleanupRemoteMeter();
        }
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
          // 尝试自动播放远端音频
          try {
            remoteVideoRef.current.muted = false;
            remoteVideoRef.current.volume = 1;
            remoteVideoRef.current.play().catch(() => undefined);
          } catch (_) {}
          audioFactory?.setStream(stream);
          setStatus('Remote audio stream connected');
          setRemoteState({ streamActive: true });
          // 远端音量检测
          try {
            cleanupRemoteMeter();
          const rctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const rsource = rctx.createMediaStreamSource(stream);
            const ranalyser = rctx.createAnalyser();
            ranalyser.fftSize = 512;
            ranalyser.smoothingTimeConstant = 0.2;
            rsource.connect(ranalyser);
            rMeterCtxRef.current = rctx;
            rMeterAnalyserRef.current = ranalyser;
            const rdata = new Uint8Array(ranalyser.fftSize);
            const rtick = () => {
              if (!rMeterAnalyserRef.current) return;
              rMeterAnalyserRef.current.getByteTimeDomainData(rdata);
              let sum = 0;
              for (let i = 0; i < rdata.length; i++) {
                const v = (rdata[i] - 128) / 128;
                sum += v * v;
              }
              const rms = Math.sqrt(sum / rdata.length);
              const level = Math.min(1, rms * 2.5);
              setRemoteState((s) => ({ ...s, micLevel: level, streamActive: true }));
              rMeterRafRef.current = requestAnimationFrame(rtick);
            };
            rMeterRafRef.current = requestAnimationFrame(rtick);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('Remote level meter init failed:', e);
          }

          // 监听远端 track 结束/静音
          stream.getTracks().forEach((t) => {
            t.addEventListener('ended', () => {
              setRemoteState({ streamActive: false, micLevel: 0 });
              cleanupRemoteMeter();
              if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null as any;
            });
            t.addEventListener('mute', () => {
              setRemoteState((s) => ({ ...s, micLevel: 0 }));
            });
            t.addEventListener('unmute', () => {
              // 恢复时由 analyser 驱动更新
            });
          });
        }
      };

      const getMediaStream = async () => {
        try {
          setStatus('Getting media stream...');
      let stream: MediaStream;
          try {
            // 使用当前选择的设备生成约束
            stream = await navigator.mediaDevices.getUserMedia(buildGumConstraints());
          } catch (_) {
            // 回退：仅音频
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          }
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) throw new Error('No audio track found');
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          localStreamRef.current = stream;
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));
          audioFactory?.setStream(stream);
          setStatus('Local audio stream connected');
          setLocalState((s) => ({ ...s, streamActive: true }));

          // 启动本地麦克风音量检测
          try {
            cleanupMeter();
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const source = ctx.createMediaStreamSource(localStreamRef.current || stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.2;
            source.connect(analyser);
            meterCtxRef.current = ctx;
            meterAnalyserRef.current = analyser;
            const data = new Uint8Array(analyser.fftSize);
            const tick = () => {
              if (!meterAnalyserRef.current) return;
              meterAnalyserRef.current.getByteTimeDomainData(data);
              // 计算归一化音量（0-1）
              let sum = 0;
              for (let i = 0; i < data.length; i++) {
                const v = (data[i] - 128) / 128; // -1..1
                sum += v * v;
              }
              const rms = Math.sqrt(sum / data.length);
              // 提升可视灵敏度并限制最大值
              const level = Math.min(1, rms * 2.5);
              setLocalState((s) => ({ ...s, micLevel: level }));
              meterRafRef.current = requestAnimationFrame(tick);
            };
            meterRafRef.current = requestAnimationFrame(tick);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('Mic level meter init failed:', e);
          }
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
        setRtcState((s) => ({ ...s, signaling: 'error' }));
        return;
      }
      setStatus('Signaling connection successful');
      setRtcState((s) => ({ ...s, signaling: 'open' }));

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
        if (members.length < 2) {
          // 房间只剩本地，认为远端已离开
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null as any;
          setRemoteState({ streamActive: false, micLevel: 0 });
          cleanupRemoteMeter();
          // 远端断开时仅保留本地流到编码工厂
          refreshAudioFactory(localStreamRef.current, null);
        }
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
            setRtcState((s) => ({ ...s, pendingCandidates: pendingRemoteCandidatesRef.current.length }));
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
      cleanupMeter();
      cleanupRemoteMeter();
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
                <div className="flex items-center space-x-4 text-xs text-gray-600">
                  <div className="flex items-center space-x-1">
                    <span className="font-semibold">Signaling</span>
                    <span className={rtcState.signaling === 'open' ? 'text-green-600' : rtcState.signaling === 'error' ? 'text-red-600' : 'text-yellow-600'}>
                      {rtcState.signaling}
                    </span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="font-semibold">PC</span>
                    <span className="text-blue-600">{rtcState.pcState || 'idle'}</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="font-semibold">ICEQ</span>
                    <span className="text-blue-600">{rtcState.pendingCandidates}</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="font-semibold">CtxSR</span>
                    <span className="text-purple-600">{encodeState.contextSampleRate || '-'}</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="font-semibold">EncSR</span>
                    <span className="text-purple-600">{encodeState.encoderSampleRate || '-'}</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="font-semibold">Chunks</span>
                    <span className="text-purple-600">{encodeState.chunkCount}</span>
                  </div>
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
              <div className="mt-3 text-xs text-gray-600 flex flex-wrap gap-3">
                <div className="flex items-center space-x-1">
                  <span className="font-semibold">Mic</span>
                  <span className={localState.micGranted ? 'text-green-600' : 'text-red-600'}>
                    {localState.micGranted ? 'granted' : 'denied'}
                  </span>
                </div>
                <div className="flex items-center space-x-1">
                  <span className="font-semibold">Device</span>
                  <span className={localState.deviceReady ? 'text-green-600' : 'text-yellow-600'}>
                    {localState.deviceReady ? 'ready' : 'checking'}
                  </span>
                </div>
                <div className="flex items-center space-x-1">
                  <span className="font-semibold">Local</span>
                  <span className={localState.streamActive ? 'text-green-600' : 'text-yellow-600'}>
                    {localState.streamActive ? 'streaming' : 'idle'}
                  </span>
                </div>
              </div>
            {/* 音量条 */}
            <div className="mt-2 h-2 bg-gray-200 rounded">
              <div
                className="h-2 bg-green-500 rounded transition-[width] duration-75"
                style={{ width: `${Math.round(((localState.micLevel || 0) * 100))}%` }}
              />
            </div>
            </div>

            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-lg font-semibold text-gray-800 mb-3">Remote Audio</h3>
              <video ref={remoteVideoRef} autoPlay className="w-full h-32 bg-gray-100 rounded border-2 border-gray-200" />
              <p className="text-sm text-gray-500 mt-2">Remote audio stream</p>
              <div className="mt-3 text-xs text-gray-600 flex items-center space-x-2">
                <span className="font-semibold">Remote</span>
                <span className={remoteState.streamActive ? 'text-green-600' : 'text-yellow-600'}>
                  {remoteState.streamActive ? 'streaming' : 'idle'}
                </span>
              </div>
              {/* 远端音量条 */}
              <div className="mt-2 h-2 bg-gray-200 rounded">
                <div
                  className="h-2 bg-blue-500 rounded transition-[width] duration-75"
                  style={{ width: `${Math.round(((remoteState.micLevel || 0) * 100))}%` }}
                />
              </div>
            </div>
          </div>
          {/* 设备选择区 */}
          <div className="bg-white rounded-lg shadow p-4 mt-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-3">Device Selection</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Microphone</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50"
                  value={selectedMicId}
                  onChange={(e) => {
                    setSelectedMicId(e.target.value);
                    updateLocalTracks('audio');
                  }}
                >
                  {devices.mics.length === 0 && <option value="">No microphone</option>}
                  {devices.mics.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 6)}`}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Camera</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50"
                  value={selectedCamId}
                  onChange={(e) => {
                    setSelectedCamId(e.target.value);
                    updateLocalTracks('video');
                  }}
                >
                  {devices.cams.length === 0 && <option value="">No camera</option>}
                  {devices.cams.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Cam ${d.deviceId.slice(0, 6)}`}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-2">切换设备将无中断地替换发送轨道，远端连接保持。</div>
          </div>
        </div>
      </div>
    </>
  );
}

